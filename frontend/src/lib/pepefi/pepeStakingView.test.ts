import { describe, it, expect } from 'vitest'

import { rewardPeriodStatus, dailyRewardPool, SECONDS_PER_DAY } from './pepeStakingView'

describe('rewardPeriodStatus', () => {
  it('periodFinish 為 0：notifyRewardAmount 從未被呼叫過', () => {
    expect(rewardPeriodStatus({ periodFinish: 0n }, 1_000)).toBe('not-started')
  })

  it('now 早於 periodFinish：獎勵期還在跑', () => {
    expect(rewardPeriodStatus({ periodFinish: 2_000n }, 1_000)).toBe('active')
  })

  it('now 等於或晚於 periodFinish：獎勵期已結束', () => {
    expect(rewardPeriodStatus({ periodFinish: 1_000n }, 1_000)).toBe('ended')
    expect(rewardPeriodStatus({ periodFinish: 1_000n }, 1_500)).toBe('ended')
  })
})

describe('dailyRewardPool', () => {
  it('獎勵期未開始或已結束：回傳 null，不虛構一個速率', () => {
    expect(dailyRewardPool({ periodFinish: 0n, rewardRate: 123n }, 1_000)).toBeNull()
    expect(dailyRewardPool({ periodFinish: 1_000n, rewardRate: 123n }, 1_000)).toBeNull()
  })

  it('獎勵期還在跑：回傳 rewardRate × 一天秒數', () => {
    const rewardRate = 5n * 10n ** 15n // 0.005 PEPE/sec
    expect(dailyRewardPool({ periodFinish: 2_000n, rewardRate }, 1_000))
      .toBe(rewardRate * SECONDS_PER_DAY)
  })
})
