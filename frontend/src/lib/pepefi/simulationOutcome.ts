import { isError } from 'ethers'
import type { ethers } from 'ethers'

export type SimulationOutcome =
  | { kind: 'rejected'; reason: string | null }
  | { kind: 'error'; reason: string }

/** eth_call 的 revert 資料在 ethers v6 會放在不同欄位，依序找。 */
export function revertData(e: unknown): string | undefined {
  const err = e as { data?: string; info?: { error?: { data?: string } }; error?: { data?: string } }
  return err.data ?? err.info?.error?.data ?? err.error?.data
}

/**
 * 把一次失敗的 eth_call 分成「合約拒絕」與「模擬本身失敗」。
 *
 * 有 revert data：ABI 認得就顯示錯誤名稱與參數，認不得（例如 exchange 自己的錯誤）或格式壞掉
 * 就顯示前 4 bytes。沒有 revert data 但 ethers 判定為 CALL_EXCEPTION：仍是合約 revert，只是
 * 沒給原因（bare `revert()`；sepolia.base.org 也可能只回 `{"code":3,"message":"execution reverted"}`），
 * reason 為 null，由畫面顯示「未提供原因」。其餘（RPC、網路）才是模擬失敗——說成「被合約拒絕」
 * 會讓評審以為合約擋下了一筆其實根本沒送到的單。
 */
export function classifySimulationFailure(e: unknown, iface: ethers.Interface): SimulationOutcome {
  const raw = revertData(e)
  if (raw && raw !== '0x') {
    let parsed: ethers.ErrorDescription | null = null
    try {
      parsed = iface.parseError(raw)
    } catch {
      parsed = null
    }
    if (!parsed) return { kind: 'rejected', reason: raw.slice(0, 10) }
    return { kind: 'rejected', reason: `${parsed.name}(${parsed.args.map(String).join(', ')})` }
  }
  if (isError(e, 'CALL_EXCEPTION')) return { kind: 'rejected', reason: null }
  return { kind: 'error', reason: (e as Error).message }
}
