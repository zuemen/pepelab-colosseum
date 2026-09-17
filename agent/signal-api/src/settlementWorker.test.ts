// settlement-worker.ts 的重試/死信邏輯，離線測試。
//   cd agent && npx tsx signal-api/src/settlementWorker.test.ts
//
// 刻意不設 FEE_SETTLEMENT_PRIVATE_KEY：這讓 settlement.ts 的 settleRevenue()
// 每次都確定性地回傳 {status:"failed", error:"settlement disabled"}，離線就能
// 驗證「失敗 N 次後死信」而不必真的送壞交易。用 Upstash stub 驗證 pushRetry /
// pushDead 寫進去的內容是否正確累計 attempts。
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const lists = new Map<string, string[]>();
function listFor(key: string): string[] {
  let l = lists.get(key);
  if (!l) {
    l = [];
    lists.set(key, l);
  }
  return l;
}
const upstash: Server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const [cmd, key, ...args] = JSON.parse(Buffer.concat(chunks).toString() || "[]") as (string | number)[];
  const ok = (result: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
  const cmdU = String(cmd).toUpperCase();
  if (cmdU === "RPUSH") {
    listFor(String(key)).push(String(args[0]));
    ok(listFor(String(key)).length);
  } else {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `unhandled cmd ${cmdU}` }));
  }
});
await new Promise<void>((r) => upstash.listen(0, "127.0.0.1", r));
const port = (upstash.address() as AddressInfo).port;

process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
delete process.env.FEE_SETTLEMENT_PRIVATE_KEY; // → settleRevenue 確定性失敗

const { processOne, MAX_RETRY_ATTEMPTS } = await import("./settlement-worker.ts");
const { RETRY_KEY, DEAD_KEY } = await import("./ledger.ts");

const entry = { trader: "0xE80A81360608C1342e66743F70a00f75d792Eb93", feeUsd: 0.01, at: 0, source: "signals" as const };

// 第一次失敗（priorAttempts=0）→ retry，attempts=1，寫進 RETRY_KEY。
{
  const o = await processOne(entry, 0);
  assert.equal(o.outcome, "retry");
  const pushed = JSON.parse(listFor(RETRY_KEY).at(-1)!) as { attempts: number; lastError: string };
  assert.equal(pushed.attempts, 1);
  assert.equal(pushed.lastError, "settlement disabled");
  console.log("第 1 次失敗 → retry, attempts=1 ✓");
}

// 重複失敗直到 attempts 達到 MAX_RETRY_ATTEMPTS → 死信。
{
  let priorAttempts = 1;
  for (let i = 2; i < MAX_RETRY_ATTEMPTS; i += 1) {
    const o = await processOne(entry, priorAttempts);
    assert.equal(o.outcome, "retry", `第 ${i} 次應該還在 retry`);
    priorAttempts = i;
  }
  const o = await processOne(entry, priorAttempts);
  assert.equal(o.outcome, "dead", `第 ${MAX_RETRY_ATTEMPTS} 次應該死信`);
  const pushed = JSON.parse(listFor(DEAD_KEY).at(-1)!) as { attempts: number };
  assert.equal(pushed.attempts, MAX_RETRY_ATTEMPTS);
  console.log(`失敗滿 ${MAX_RETRY_ATTEMPTS} 次 → dead-lettered ✓`);
}

await new Promise<void>((r) => upstash.close(() => r()));
console.log("settlementWorker.test.ts ✓ all assertions passed");
