// x402 結算 worker：把 ledger.ts 佇列裡「已收款、待分潤」的項目批次送上鏈。
//
// 優先序 1（x402 硬化）的第二半：app.ts 的付費端點只記帳（推進 Upstash 佇列），
// 不再送任何交易；上鏈這件事全部集中在這支腳本，用單一 signer 依序處理。
//
// 為什麼放在 signal-api/src/ 而不是 agent/keeper/：這支只依賴同目錄的
// settlement.ts / ledger.ts（都是 signal-api 的模組），放進 keeper/ 會變成跨
// workspace 的相對路徑匯入，徒增匯入路徑的脆弱性。**執行模型**沿用
// agent/keeper 的既有 pattern——單一 CLI 腳本、單一 signer、GitHub Actions cron、
// 缺 secret 直接 fail fast、印一行摘要讓 workflow 用門檻判斷成功與否——只是
// 檔案實際放在跟它依賴的程式碼同一個目錄。
//
// 用法：
//   cd agent
//   npx tsx signal-api/src/settlement-worker.ts
//
// 需要的 env（見 .env.example）：
//   FEE_SETTLEMENT_PRIVATE_KEY  單一 signer，跟以前一樣（settlement.ts 沒變）
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   佇列
//
// 為什麼「單一 signer」就讓 nonce 衝突在設計上消失：以前是「每個 Vercel 實例各自
// 在請求路徑裡送交易」，跨實例並發、共用同一把私鑰，nonce 序列互相打架。現在
// 送交易的地方只剩這一支 process、由 GitHub Actions cron 觸發、用 concurrency
// group 防止同一支 workflow 重疊執行（見 .github/workflows/x402-settlement-worker.yml）
// ——任何時刻至多一個 process 持有這把私鑰在送交易，nonce 序列只有一條。
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { isSettlementEnabled, settleRevenue } from "./settlement.ts";
import {
  isLedgerEnabled,
  dequeueBatch,
  dequeueRetryBatch,
  pushRetry,
  pushDead,
  queueDepth,
  QUEUE_KEY,
  RETRY_KEY,
  DEAD_KEY,
  type LedgerEntry,
  type RetryEntry,
} from "./ledger.ts";

const BATCH_SIZE = Number(process.env.SETTLEMENT_BATCH_SIZE ?? "25");
export const MAX_RETRY_ATTEMPTS = Number(process.env.SETTLEMENT_MAX_RETRIES ?? "5");
// 部分失敗門檻：沿用 keeper 系列 workflow 的慣例（MAX_FAIL_PCT），失敗率超過
// 這個百分比就讓 CI job 變紅，不要讓「11 筆壞 7 筆」看起來像成功。
const MAX_FAIL_PCT = Number(process.env.SETTLEMENT_MAX_FAIL_PCT ?? "30");

export type ProcessOutcome = { outcome: "settled"; tx: string } | { outcome: "retry" | "dead"; error: string };

/**
 * 處理單一筆待結算項目，回傳結果而不是直接改 module 級計數器——讓 main() 之外
 * 的呼叫端（測試）可以直接驅動這個函式並檢查結果，不需要先通過 main() 開頭那段
 * 「沒 signer/沒佇列就直接 exit(1)」的前置檢查。
 */
export async function processOne(entry: LedgerEntry, priorAttempts: number): Promise<ProcessOutcome> {
  const r = await settleRevenue(entry.trader, entry.feeUsd);
  if (r.status === "settled") {
    console.log(
      `settled trader=${entry.trader} feeUsd=${entry.feeUsd} source=${entry.source} tx=${r.tx}`,
    );
    return { outcome: "settled", tx: r.tx! };
  }
  const attempts = priorAttempts + 1;
  const error = r.error ?? "unknown error";
  const retryEntry: RetryEntry = { entry, attempts, lastError: error };
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    await pushDead(retryEntry);
    console.error(
      `::error::dead-lettered trader=${entry.trader} feeUsd=${entry.feeUsd} ` +
        `attempts=${attempts} error=${error}`,
    );
    return { outcome: "dead", error };
  }
  await pushRetry(retryEntry);
  console.warn(
    `retry trader=${entry.trader} feeUsd=${entry.feeUsd} attempts=${attempts} error=${error}`,
  );
  return { outcome: "retry", error };
}

async function main(): Promise<void> {
  if (!isSettlementEnabled()) {
    console.error("::error::FEE_SETTLEMENT_PRIVATE_KEY 未設 —— worker 沒有 signer 可以送交易。");
    process.exit(1);
  }
  if (!isLedgerEnabled()) {
    console.error(
      "::error::UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 未設 —— 沒有佇列可以讀。",
    );
    process.exit(1);
  }

  let settled = 0;
  let retried = 0;
  let dead = 0;
  let failed = 0;

  // 先處理重試佇列：這些已經失敗過至少一次，優先清掉避免無限期卡在佇列尾端。
  const retryBatch = await dequeueRetryBatch(BATCH_SIZE);
  for (const r of retryBatch) {
    const o = await processOne(r.entry, r.attempts);
    if (o.outcome === "settled") settled += 1;
    else {
      failed += 1;
      if (o.outcome === "dead") dead += 1;
      else retried += 1;
    }
  }

  // 剩餘預算才處理新項目；批次上限是「一次 cron 觸發最多處理幾筆」，不是佇列容量。
  const remaining = Math.max(0, BATCH_SIZE - retryBatch.length);
  const mainBatch = remaining > 0 ? await dequeueBatch(QUEUE_KEY, remaining) : [];
  for (const entry of mainBatch) {
    const o = await processOne(entry, 0);
    if (o.outcome === "settled") settled += 1;
    else {
      failed += 1;
      if (o.outcome === "dead") dead += 1;
      else retried += 1;
    }
  }

  const available = retryBatch.length + mainBatch.length;
  const [queueRemaining, retryRemaining, deadTotal] = await Promise.all([
    queueDepth(QUEUE_KEY),
    queueDepth(RETRY_KEY),
    queueDepth(DEAD_KEY),
  ]);

  console.log(
    `available=${available} settled=${settled} failed=${failed} retried=${retried} dead=${dead} ` +
      `queueRemaining=${queueRemaining} retryRemaining=${retryRemaining} deadTotal=${deadTotal}`,
  );

  if (deadTotal > 0) {
    console.warn(
      `::warning::死信佇列（${DEAD_KEY}）目前有 ${deadTotal} 筆，重試 ${MAX_RETRY_ATTEMPTS} 次仍失敗，需要人工介入。`,
    );
  }

  if (available === 0) {
    console.log("佇列淨空，這次沒有要處理的項目。");
    return;
  }

  if (failed > 0) {
    const pct = Math.round((failed / available) * 100);
    console.log(`失敗率 ${pct}%（門檻 ${MAX_FAIL_PCT}%）`);
    if (pct > MAX_FAIL_PCT) {
      console.error(
        `::error::${available} 筆中有 ${failed} 筆失敗（${pct}% > ${MAX_FAIL_PCT}%），不要當成成功。`,
      );
      process.exit(1);
    }
  }
}

// 只有直接跑這支腳本（`npx tsx signal-api/src/settlement-worker.ts`）才自動執行
// main()；被 import 時不執行（settlement-worker.test.ts 要 import processOne，
// 不能一 import 就因為測試環境沒有 signer/佇列而 process.exit(1)）。
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMain) {
  await main();
}
