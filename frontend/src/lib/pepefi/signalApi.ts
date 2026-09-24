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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

/**
 * 正式建置卻仍指向本機 = 這個部署沒有公開的 signal-api（例如 GitHub Pages 的評審版）。
 * 這時前端不該去連：訪客的電腦上沒有這個服務，一定失敗；新版 Chrome 還會對公開網頁
 * 存取 localhost 跳出區域網路權限提示。各頁改顯示「—」與說明，而不是 $0 或錯誤訊息。
 */
export function isPublicSignalApi(url: string, isDev: boolean): boolean {
  if (isDev) return true
  if (url.startsWith('/')) return true // same-origin path, e.g. behind a reverse proxy
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return !LOCAL_HOSTS.has(host)
  } catch {
    return false
  }
}

export const SIGNAL_API_AVAILABLE = isPublicSignalApi(SIGNAL_API_URL, import.meta.env.DEV)

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
