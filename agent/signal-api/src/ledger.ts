// x402 結算帳本：Upstash Redis（REST API，無需長連線，serverless 友善）。
//
// 優先序 1（x402 硬化）：把「記帳」跟「上鏈結算」拆開。付費端點只在這裡把
// (trader, feeUsd, timestamp) 推進佇列，立刻回應；上鏈結算改由 settlement-worker.ts
// 這個獨立 worker 定期批次處理，見該檔案開頭的說明。
//
// 為什麼是 Upstash 而不是自己 host 一個 Redis：這個專案跑在 Vercel serverless，
// 沒有常駐 process 可以持有 TCP 連線；Upstash 的 REST API 每次呼叫都是一個獨立的
// HTTPS 請求，跟 serverless 的執行模型天然吻合，不需要連線池。
//
// 通用指令端點：POST {url} body=["CMD", arg1, arg2, ...]（Upstash REST API 文件）。
// 不用官方 SDK：只需要 RPUSH / LPOP / LLEN 三個指令，直接 fetch 比多引入一個依賴
// 更小的變動面。

// 讀 env 故意不在 module 頂層做一次性快取（跟 settlement.ts 的 FEE_SETTLEMENT_PRIVATE_KEY
// 不同）：這支會被 app.ts 跟 settlement-worker.ts 兩種行程 import，且測試需要在
// 同一個 process 裡切換「有設定 / 沒設定」兩種狀態（例如驗證 ledger 未設定時的
// settleError 訊息），每次呼叫時讀一次 process.env 成本可忽略，換來可測試性。
function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

// 主佇列（待結算）、失敗佇列（重試中）、死信佇列（超過重試上限，需要人工介入）。
// 三個分開而不是共用一個欄位標狀態：LPOP 對「佇列裡混著不同狀態的項目」沒有
// 選擇性彈出的能力，分開的 list 讓 worker 可以用 LPOP 天然地只處理該處理的那批。
export const QUEUE_KEY = "x402:settlement:queue";
export const RETRY_KEY = "x402:settlement:retry";
export const DEAD_KEY = "x402:settlement:dead";

export interface LedgerEntry {
  trader: string;
  feeUsd: number;
  /** unix 秒 */
  at: number;
  /** 來自哪個付費端點，純粹方便事後排查，不影響結算邏輯。 */
  source: "signals" | "oracle";
}

export interface RetryEntry {
  entry: LedgerEntry;
  attempts: number;
  lastError: string;
}

export function isLedgerEnabled(): boolean {
  return credentials() !== null;
}

async function command<T = unknown>(cmd: (string | number)[]): Promise<T> {
  const creds = credentials();
  if (!creds) {
    throw new Error("ledger disabled：未設定 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  }
  const res = await fetch(creds.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  const body = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || body.error) {
    throw new Error(`Upstash ${cmd[0]} 失敗：${body.error ?? res.statusText}`);
  }
  return body.result as T;
}

/**
 * 把一筆待分潤的費用推進主佇列。**不等待任何鏈上交易**——這正是這次改動的重點：
 * 付費端點的回應不再被 tx.wait() 卡住，只等這一次 HTTPS 往返（同區域通常 <100ms）。
 */
export async function enqueueSettlement(entry: LedgerEntry): Promise<void> {
  await command(["RPUSH", QUEUE_KEY, JSON.stringify(entry)]);
}

/** worker 用：一次最多彈出 `count` 筆主佇列項目（FIFO：RPUSH 進、LPOP 出）。 */
export async function dequeueBatch(key: string, count: number): Promise<LedgerEntry[]> {
  const raw = await command<string[] | null>(["LPOP", key, count]);
  if (!raw) return [];
  return raw.map((s) => JSON.parse(s) as LedgerEntry);
}

/** worker 用：重試佇列存的是 `RetryEntry`（多帶 attempts/lastError），型別不同故分開。 */
export async function dequeueRetryBatch(count: number): Promise<RetryEntry[]> {
  const raw = await command<string[] | null>(["LPOP", RETRY_KEY, count]);
  if (!raw) return [];
  return raw.map((s) => JSON.parse(s) as RetryEntry);
}

export async function pushRetry(r: RetryEntry): Promise<void> {
  await command(["RPUSH", RETRY_KEY, JSON.stringify(r)]);
}

export async function pushDead(r: RetryEntry): Promise<void> {
  await command(["RPUSH", DEAD_KEY, JSON.stringify(r)]);
}

export async function queueDepth(key: string): Promise<number> {
  return command<number>(["LLEN", key]);
}
