// 公開 x402 Signal API 的基底網址。正式環境設 VITE_SIGNAL_API_URL 覆寫；
// 未設時預設指向本機 signal-api（`npm run signal-api`）。刻意**不**預設到原專案
// pepelab_onchain_cfd 的 Vercel 部署：本 repo 不得付費或寫入原專案的服務。
// 前端各頁（文件頁 / 監控 / 試買）共用。
export const DEFAULT_SIGNAL_API_URL =
  'http://localhost:4021'

export const SIGNAL_API_URL: string = (
  (import.meta.env.VITE_SIGNAL_API_URL as string | undefined) ??
  DEFAULT_SIGNAL_API_URL
).replace(/\/$/, '')

/** 訪客試買：呼叫伺服器端 demo 購買（伺服器代付 x402，回真實 settlement tx）。 */
export async function demoBuySignal(trader?: string): Promise<{
  ok: boolean
  error?: string
  settlementTx?: string
  trader?: string
  signal?: unknown
  paymentInfo?: unknown
}> {
  const res = await fetch(`${SIGNAL_API_URL}/demo/buy-signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trader ? { trader } : {}),
  })
  return res.json()
}
