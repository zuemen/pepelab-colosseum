import { describe, it, expect } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import {
  planAdoption,
  runAdoption,
  toSpotAllocation,
  type LegOutcome,
  type PlannedLeg,
  type SpotLeg,
} from './allocationAdoption'
import type { RawAlloc } from './leaderboardMetrics'

// issue #149 / ADR-007：採用一個配置 = 照發布者目前的比例買進現貨代幣。
// 這份測試守的是「什麼樣的已發布配置能用現貨表達」與「採用流程不會悄悄部分成功」。

const TOKENS = {
  sBTC: '0x00000000000000000000000000000000000000b1',
  sGOLD: '0x00000000000000000000000000000000000000a1',
  sBOND: '0x00000000000000000000000000000000000000c1',
}

const alloc = (asset: string, weight: bigint, over: Partial<RawAlloc> = {}): RawAlloc => ({
  asset,
  weight,
  isLong: true,
  leverage: 1n,
  ...over,
})

describe('toSpotAllocation', () => {
  it('turns an all-long published allocation into spot legs at the published weights', () => {
    const result = toSpotAllocation(
      [
        alloc(ASSET_IDS.sBTC, 5_000n, { leverage: 3n }),
        alloc(ASSET_IDS.sGOLD, 3_000n),
        alloc(ASSET_IDS.sBOND, 2_000n),
      ],
      TOKENS,
    )

    expect(result).toEqual({
      ok: true,
      legs: [
        { assetId: ASSET_IDS.sBTC, symbol: 'sBTC', weightBps: 5_000 },
        { assetId: ASSET_IDS.sGOLD, symbol: 'sGOLD', weightBps: 3_000 },
        { assetId: ASSET_IDS.sBOND, symbol: 'sBOND', weightBps: 2_000 },
      ],
    })
  })

  it('refuses an allocation with a short leg — a short cannot be bought as a token', () => {
    const result = toSpotAllocation(
      [
        alloc(ASSET_IDS.sBTC, 5_000n),
        alloc(ASSET_IDS.sGOLD, 3_000n, { isLong: false }),
        alloc(ASSET_IDS.sBOND, 2_000n),
      ],
      TOKENS,
    )
    expect(result).toEqual({ ok: false, reason: 'notSpot' })
  })

  it('refuses an allocation naming an asset with no token on this chain', () => {
    const result = toSpotAllocation(
      [
        alloc(ASSET_IDS.sBTC, 5_000n),
        alloc(ASSET_IDS.sGOLD, 3_000n),
        alloc(ASSET_IDS.sTSLA, 2_000n),
      ],
      TOKENS,
    )
    expect(result).toEqual({ ok: false, reason: 'notTokenized' })
  })

  it('refuses an asset id the app does not recognise at all', () => {
    const result = toSpotAllocation(
      [alloc(ASSET_IDS.sBTC, 5_000n), alloc(ASSET_IDS.sGOLD, 3_000n), alloc('0xdead', 2_000n)],
      TOKENS,
    )
    expect(result).toEqual({ ok: false, reason: 'notTokenized' })
  })

  it('refuses an empty allocation', () => {
    expect(toSpotAllocation([], TOKENS)).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses weights that do not sum to the whole', () => {
    const result = toSpotAllocation(
      [alloc(ASSET_IDS.sBTC, 5_000n), alloc(ASSET_IDS.sGOLD, 3_000n), alloc(ASSET_IDS.sBOND, 1_000n)],
      TOKENS,
    )
    expect(result).toEqual({ ok: false, reason: 'badWeights' })
  })
})

const leg = (symbol: SpotLeg['symbol'], weightBps: number): SpotLeg => ({
  assetId: ASSET_IDS[symbol],
  symbol,
  weightBps,
})

describe('planAdoption', () => {
  const USDC = 10n ** 18n

  it('splits the amount by weight', () => {
    const result = planAdoption(1_000n * USDC, [leg('sBTC', 5_000), leg('sGOLD', 3_000), leg('sBOND', 2_000)])
    expect(result).toEqual({
      ok: true,
      legs: [
        { ...leg('sBTC', 5_000), usdc: 500n * USDC },
        { ...leg('sGOLD', 3_000), usdc: 300n * USDC },
        { ...leg('sBOND', 2_000), usdc: 200n * USDC },
      ],
    })
  })

  it('gives rounding dust to the heaviest leg so the legs spend exactly the amount entered', () => {
    // 7 × 33.34% = 2.33 → 2, 7 × 33.33% = 2.33 → 2, 同上 2；差的 1 給權重最大的那檔。
    const result = planAdoption(7n, [leg('sBTC', 3_333), leg('sGOLD', 3_334), leg('sBOND', 3_333)])
    expect(result.ok && result.legs.map((l) => l.usdc)).toEqual([2n, 3n, 2n])
  })

  it('refuses an amount too small to give every leg something — the vault rejects a zero buy', () => {
    expect(planAdoption(2n, [leg('sBTC', 5_000), leg('sGOLD', 3_000), leg('sBOND', 2_000)])).toEqual({
      ok: false,
      reason: 'tooSmall',
    })
  })

  it('refuses a zero amount', () => {
    expect(planAdoption(0n, [leg('sBTC', 5_000), leg('sGOLD', 5_000)])).toEqual({ ok: false, reason: 'tooSmall' })
  })
})

describe('runAdoption', () => {
  const PLAN: PlannedLeg[] = [
    { ...leg('sBTC', 5_000), usdc: 500n },
    { ...leg('sGOLD', 3_000), usdc: 300n },
    { ...leg('sBOND', 2_000), usdc: 200n },
  ]

  /** 假的鏈：記下每一次呼叫的順序，指定哪些檢查／鑄造要失敗。 */
  function fakeChain(opts: { checkFails?: string[]; mintFails?: string[]; approveFails?: boolean } = {}) {
    const calls: string[] = []
    return {
      calls,
      deps: {
        check: async (l: PlannedLeg) => {
          calls.push(`check ${l.symbol}`)
          if (opts.checkFails?.includes(l.symbol)) throw new Error(`${l.symbol} halted`)
        },
        approve: async (total: bigint) => {
          calls.push(`approve ${total}`)
          if (opts.approveFails) throw new Error('user rejected')
        },
        mint: async (l: PlannedLeg) => {
          calls.push(`mint ${l.symbol} ${l.usdc}`)
          if (opts.mintFails?.includes(l.symbol)) throw new Error(`${l.symbol} reverted`)
          return `0xhash-${l.symbol}`
        },
      },
    }
  }

  const statuses = (legs: LegOutcome[]) => legs.map((l) => `${l.symbol}:${l.status}`)

  it('checks every leg, approves the total once, then buys each leg in order', async () => {
    const chain = fakeChain()
    const result = await runAdoption(PLAN, chain.deps)

    expect(chain.calls).toEqual([
      'check sBTC', 'check sGOLD', 'check sBOND',
      'approve 1000',
      'mint sBTC 500', 'mint sGOLD 300', 'mint sBOND 200',
    ])
    expect(result.outcome).toBe('complete')
    expect(statuses(result.legs)).toEqual(['sBTC:bought', 'sGOLD:bought', 'sBOND:bought'])
    expect(result.legs.map((l) => l.txHash)).toEqual(['0xhash-sBTC', '0xhash-sGOLD', '0xhash-sBOND'])
  })

  it('sends nothing when any leg fails its check, and names every leg that cannot be bought', async () => {
    const chain = fakeChain({ checkFails: ['sGOLD', 'sBOND'] })
    const result = await runAdoption(PLAN, chain.deps)

    expect(chain.calls).toEqual(['check sBTC', 'check sGOLD', 'check sBOND'])
    expect(result.outcome).toBe('blocked')
    expect(statuses(result.legs)).toEqual(['sBTC:notStarted', 'sGOLD:unavailable', 'sBOND:unavailable'])
    expect((result.legs[1].error as Error).message).toBe('sGOLD halted')
  })

  it('buys nothing when the approval is refused', async () => {
    const chain = fakeChain({ approveFails: true })
    const result = await runAdoption(PLAN, chain.deps)

    expect(chain.calls.some((c) => c.startsWith('mint'))).toBe(false)
    expect(result.outcome).toBe('failed')
    expect(statuses(result.legs)).toEqual(['sBTC:notStarted', 'sGOLD:notStarted', 'sBOND:notStarted'])
    expect((result.error as Error).message).toBe('user rejected')
  })

  it('stops at the first failed buy and reports exactly what was and was not bought', async () => {
    const chain = fakeChain({ mintFails: ['sGOLD'] })
    const result = await runAdoption(PLAN, chain.deps)

    expect(chain.calls).not.toContain('mint sBOND 200')
    expect(result.outcome).toBe('partial')
    expect(statuses(result.legs)).toEqual(['sBTC:bought', 'sGOLD:failed', 'sBOND:notStarted'])
    expect(result.legs[0].txHash).toBe('0xhash-sBTC')
    expect((result.legs[1].error as Error).message).toBe('sGOLD reverted')
  })

  it('calls it failed, not partial, when the very first buy fails', async () => {
    const result = await runAdoption(PLAN, fakeChain({ mintFails: ['sBTC'] }).deps)
    expect(result.outcome).toBe('failed')
    expect(statuses(result.legs)).toEqual(['sBTC:failed', 'sGOLD:notStarted', 'sBOND:notStarted'])
  })

  it('reports progress so the screen can show which leg is being bought right now', async () => {
    const chain = fakeChain()
    const seen: string[][] = []
    let latest: LegOutcome[] = []
    await runAdoption(PLAN, {
      ...chain.deps,
      mint: async (l) => {
        seen.push(statuses(latest))
        return chain.deps.mint(l)
      },
    }, (legs) => { latest = legs })

    expect(seen[1]).toEqual(['sBTC:bought', 'sGOLD:buying', 'sBOND:waiting'])
  })
})
