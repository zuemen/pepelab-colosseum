import { BrowserProvider } from 'ethers'
import { describe, it, expect } from 'vitest'

import {
  sendCallsParams, parseCallsStatus, isUnsupportedMethod, isUserRejection, isVersionMismatch, walletError, supportsAtomicBatch,
} from './walletCalls'

const FROM = '0x56D83fEe6cf6F0BFf345640C7527a1869677435F'
const calls = [
  { to: '0xf85210B21cC50302F477BA56686d2019dC9b67Ad', value: 0n, data: '0x1234' },
  { to: '0x20277169a755C690b98F0894EF57AF835469C9Af', value: 5n, data: '0xabcd' },
]

describe('sendCallsParams', () => {
  it('EIP-5792 2.0.0：鏈 id 與 value 用 hex，要求原子執行', () => {
    expect(sendCallsParams(calls, FROM, 84532)).toEqual([
      {
        version: '2.0.0',
        chainId: '0x14a34',
        from: FROM,
        atomicRequired: true,
        calls: [
          { to: calls[0].to, data: '0x1234', value: '0x0' },
          { to: calls[1].to, data: '0xabcd', value: '0x5' },
        ],
      },
    ])
  })

  it('1.0 格式（較舊的錢包）', () => {
    const p = sendCallsParams(calls, FROM, 84532, '1.0')[0] as Record<string, unknown>
    expect(p.version).toBe('1.0')
    expect(p).not.toHaveProperty('atomicRequired')
  })
})

describe('parseCallsStatus', () => {
  const receipt = { status: '0x1', transactionHash: '0xaaa' }
  it('2.0.0：200 = 已確認，取第一筆收據的 hash', () => {
    expect(parseCallsStatus({ status: 200, receipts: [receipt] })).toEqual({ state: 'confirmed', txHash: '0xaaa' })
  })
  it('2.0.0：100 = 處理中；400／500／600 = 失敗', () => {
    expect(parseCallsStatus({ status: 100 }).state).toBe('pending')
    expect(parseCallsStatus({ status: 400 }).state).toBe('failed')
    expect(parseCallsStatus({ status: 500, receipts: [{ status: '0x0', transactionHash: '0xbbb' }] })).toEqual({ state: 'failed', txHash: '0xbbb' })
    expect(parseCallsStatus({ status: 600 }).state).toBe('failed')
  })
  it('1.0：PENDING／CONFIRMED 字串；收據 status 0x0 視為失敗', () => {
    expect(parseCallsStatus({ status: 'PENDING' }).state).toBe('pending')
    expect(parseCallsStatus({ status: 'CONFIRMED', receipts: [receipt] })).toEqual({ state: 'confirmed', txHash: '0xaaa' })
    expect(parseCallsStatus({ status: 'CONFIRMED', receipts: [{ status: '0x0', transactionHash: '0xccc' }] })).toEqual({ state: 'failed', txHash: '0xccc' })
  })
  it('看不懂的回應 → pending（繼續輪詢，由呼叫端的逾時收尾）', () => {
    expect(parseCallsStatus(null).state).toBe('pending')
    expect(parseCallsStatus({}).state).toBe('pending')
  })
})

describe('isUnsupportedMethod', () => {
  it('EIP-1193 4200、JSON-RPC -32601 與常見訊息都算「錢包不支援」', () => {
    expect(isUnsupportedMethod({ code: 4200 })).toBe(true)
    expect(isUnsupportedMethod({ error: { code: -32601 } })).toBe(true)
    expect(isUnsupportedMethod(new Error('the method wallet_sendCalls does not exist / is not available'))).toBe(true)
    expect(isUnsupportedMethod({ code: 4001, message: 'User rejected the request' })).toBe(false)
  })
})

describe('supportsAtomicBatch', () => {
  it('2.0.0：只有 supported 算；ready（要先用 EIP-7702 升級帳戶）不算', () => {
    expect(supportsAtomicBatch({ '0x14a34': { atomic: { status: 'supported' } } }, 84532)).toBe(true)
    expect(supportsAtomicBatch({ '0x14a34': { atomic: { status: 'ready' } } }, 84532)).toBe(false)
    expect(supportsAtomicBatch({ '0x14a34': { atomic: { status: 'unsupported' } } }, 84532)).toBe(false)
  })
  it('1.0：atomicBatch.supported', () => {
    expect(supportsAtomicBatch({ '0x14a34': { atomicBatch: { supported: true } } }, 84532)).toBe(true)
  })
  it('別條鏈或沒有回應 → false', () => {
    expect(supportsAtomicBatch({ '0x1': { atomic: { status: 'supported' } } }, 84532)).toBe(false)
    expect(supportsAtomicBatch(null, 84532)).toBe(false)
  })
})

/** An EIP-1193 wallet on Base Sepolia whose wallet_sendCalls fails with `error`, seen through ethers like the card sees it. */
async function sendCallsError(error: { code: number; message: string }): Promise<unknown> {
  const provider = new BrowserProvider({
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x14a34'
      throw error
    },
  })
  try {
    await provider.send('wallet_sendCalls', sendCallsParams(calls, FROM, 84532))
  } catch (e) {
    return e
  }
  throw new Error('expected wallet_sendCalls to fail')
}

describe('錢包錯誤經過 ethers 包裝後（卡片實際拿到的形狀）', () => {
  it('使用者拒絕（4001）：是拒絕，不是版本問題，不會再跳第二次錢包', async () => {
    const e = await sendCallsError({ code: 4001, message: 'User rejected the request.' })
    expect((e as Error).message).toMatch(/version=/) // ethers 的包裝訊息一定帶 version=，不能拿它比對
    expect(isUserRejection(e)).toBe(true)
    expect(isVersionMismatch(e)).toBe(false)
    expect(isUnsupportedMethod(e)).toBe(false)
  })
  it('錢包不認得 2.0.0 → 版本問題（改用 1.0 重送）', async () => {
    const e = await sendCallsError({ code: -32602, message: 'Unsupported wallet_sendCalls version: 2.0.0' })
    expect(isVersionMismatch(e)).toBe(true)
    expect(isUserRejection(e)).toBe(false)
  })
  it('錢包沒有這個方法 → 不支援', async () => {
    expect(isUnsupportedMethod(await sendCallsError({ code: 4200, message: 'The requested method is not supported' }))).toBe(true)
    expect(isUnsupportedMethod(await sendCallsError({ code: -32601, message: 'the method wallet_sendCalls does not exist/is not available' }))).toBe(true)
  })
  it('其他錯誤：三者皆否，walletError 取回錢包原本的訊息', async () => {
    const e = await sendCallsError({ code: -32603, message: 'Internal error' })
    expect([isUserRejection(e), isVersionMismatch(e), isUnsupportedMethod(e)]).toEqual([false, false, false])
    expect(walletError(e)).toEqual({ code: -32603, message: 'Internal error' })
  })
})
