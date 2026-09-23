import type { ethers } from 'ethers'

export type SimulationOutcome =
  | { kind: 'rejected'; reason: string }
  | { kind: 'error'; reason: string }

/** eth_call 的 revert 資料在 ethers v6 會放在不同欄位，依序找。 */
export function revertData(e: unknown): string | undefined {
  const err = e as { data?: string; info?: { error?: { data?: string } }; error?: { data?: string } }
  return err.data ?? err.info?.error?.data ?? err.error?.data
}

/**
 * 把一次失敗的 eth_call 分成「合約拒絕」與「模擬本身失敗」。
 *
 * 只有拿得到 revert data 才算合約拒絕：ABI 認得就顯示錯誤名稱與參數，認不得（例如
 * exchange 自己的錯誤）就顯示 4-byte selector。拿不到資料多半是 RPC 或網路出錯，
 * 這時說「被合約拒絕」會讓評審以為合約擋下了一筆其實根本沒送到的單。
 */
export function classifySimulationFailure(e: unknown, iface: ethers.Interface): SimulationOutcome {
  const raw = revertData(e)
  if (!raw || raw === '0x') return { kind: 'error', reason: (e as Error).message }

  const parsed = iface.parseError(raw)
  if (!parsed) return { kind: 'rejected', reason: raw.slice(0, 10) }
  return { kind: 'rejected', reason: `${parsed.name}(${parsed.args.map(String).join(', ')})` }
}
