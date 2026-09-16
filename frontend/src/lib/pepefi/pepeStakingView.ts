// PepeStaking(#155)的鏈上讀值 → 顯示狀態,純函式,不含 fetch 或 ethers 呼叫。
//
// 這顆合約的獎勵期是 Synthetix 式的:owner 呼叫 notifyRewardAmount() 才會把
// rewardRate 設成非零、periodFinish 往後推 7 天。過期或從未開始時 rewardRate
// 的舊值仍留在鏈上 storage 裡,但不會再累積——直接拿 rewardRate 當「目前收益」
// 顯示會在期滿後説謊。這裡把「有沒有正在跑的獎勵期」與「跑的時候速率是多少」
// 分開,好讓 UI 誠實地區分「查看待領獎勵、領取獎勵」與「獎勵期已結束、等待
// 下一輪挹注」。

export const SECONDS_PER_DAY = 86_400n

export interface RewardPeriodState {
  /** notifyRewardAmount() 設定的下一次 7 天週期到期時間;從未呼叫過則為 0。 */
  periodFinish: bigint
  rewardRate?:  bigint
}

export type RewardPeriodStatus = 'not-started' | 'active' | 'ended'

/** `nowSec` 用 number(Date.now()/1000 的等級)即可,不需要鏈上時間。 */
export function rewardPeriodStatus(
  state: Pick<RewardPeriodState, 'periodFinish'>,
  nowSec: number,
): RewardPeriodStatus {
  if (state.periodFinish === 0n) return 'not-started'
  return BigInt(Math.floor(nowSec)) < state.periodFinish ? 'active' : 'ended'
}

/**
 * 目前這一刻,所有質押者合計每天能領到的 PEPE。
 * 獎勵期未開始或已過期時回傳 null——不要用一個已經停止累積的 rewardRate
 * 算出一個看起來仍在跑的數字。
 */
export function dailyRewardPool(
  state: Required<RewardPeriodState>,
  nowSec: number,
): bigint | null {
  if (rewardPeriodStatus(state, nowSec) !== 'active') return null
  return state.rewardRate * SECONDS_PER_DAY
}
