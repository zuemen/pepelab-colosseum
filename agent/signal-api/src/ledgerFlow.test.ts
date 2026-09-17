// 優先序 1（x402 硬化：記帳 + 批次結算）的端到端離線測試。
//   cd agent && npx tsx signal-api/src/ledgerFlow.test.ts
//
// 用兩個本機 stub 取代 facilitator 與 Upstash，全程不打網路、不碰鏈上——關鍵是
// 這個測試**完全不設 FEE_SETTLEMENT_PRIVATE_KEY**：如果付費端點的回應路徑還殘留
// 任何一次鏈上呼叫，這裡就不會通過（因為沒有 signer，settleRevenue() 一被呼叫
// 就會回 "settlement disabled"，而這裡驗證的是它**根本不會被呼叫**）。
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ── stub facilitator：/verify 一律通過，/settle 依 settleMode 決定成敗 ────────
let settleMode: "success" | "fail" = "success";
const facilitator: Server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
    paymentPayload?: { payload?: { authorization?: { from?: string } } };
  };
  const payer = body.paymentPayload?.payload?.authorization?.from ?? "0x0";
  if (req.url === "/verify") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ isValid: true, payer }));
    return;
  }
  if (req.url === "/settle") {
    if (settleMode === "success") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ success: true, transaction: "0x" + "ab".repeat(32), network: "base-sepolia", payer }));
    } else {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ success: false, errorReason: "simulated_settle_failure", transaction: "", network: "base-sepolia", payer }));
    }
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => facilitator.listen(0, "127.0.0.1", r));
const facilitatorPort = (facilitator.address() as AddressInfo).port;

// ── stub Upstash REST：只認 RPUSH / LPOP / LLEN，維護記憶體內的 list ─────────
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
  } else if (cmdU === "LPOP") {
    const count = args[0] !== undefined ? Number(args[0]) : 1;
    const l = listFor(String(key));
    const popped = l.splice(0, count);
    ok(popped.length ? popped : null);
  } else if (cmdU === "LLEN") {
    ok(listFor(String(key)).length);
  } else {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `unhandled cmd ${cmdU}` }));
  }
});
await new Promise<void>((r) => upstash.listen(0, "127.0.0.1", r));
const upstashPort = (upstash.address() as AddressInfo).port;

// ── 設定 env（必須在 import app.ts 之前）：刻意不設 FEE_SETTLEMENT_PRIVATE_KEY ──
process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${facilitatorPort}`;
process.env.X402_NETWORK = "base-sepolia";
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${upstashPort}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
delete process.env.FEE_SETTLEMENT_PRIVATE_KEY;

const { createApp } = await import("./app.ts");
const { QUEUE_KEY } = await import("./ledger.ts");
const app = createApp();

const trader = "0xE80A81360608C1342e66743F70a00f75d792Eb93";
function xPaymentFor(from: string): string {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "0x" + "ab".repeat(65),
        authorization: {
          from,
          to: trader,
          value: "10000",
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: "0x" + "cd".repeat(32),
        },
      },
    }),
  ).toString("base64");
}

// ── 1) facilitator settle 成功 → 記一筆帳，settled:true，且沒有任何鏈上呼叫 ──
{
  const before = listFor(QUEUE_KEY).length;
  settleMode = "success";
  const payer = "0x1111111111111111111111111111111111111111";
  const r = await app.request(`/signals/${trader}`, { headers: { "X-PAYMENT": xPaymentFor(payer) } });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  const j = (await r.json()) as { ok: boolean; settled: boolean; settleError?: string; data: unknown };
  assert.equal(j.ok, true);
  assert.equal(j.settled, true, "settle 成功時 settled 必須是 true");
  assert.equal(j.settleError, undefined);
  assert.ok(j.data, "付費者仍要拿到訊號資料");

  const after = listFor(QUEUE_KEY);
  assert.equal(after.length, before + 1, "必須剛好新增一筆佇列項目");
  const entry = JSON.parse(after[after.length - 1]!) as { trader: string; feeUsd: number; source: string };
  assert.equal(entry.trader, trader);
  assert.equal(entry.feeUsd, 0.01);
  assert.equal(entry.source, "signals");
  console.log("facilitator settle 成功 → 記帳一筆，settled:true，無鏈上呼叫 ✓");
}

// ── 2) facilitator settle 失敗 → 402，且**不**記帳（順序 bug 的修法）─────────
{
  const before = listFor(QUEUE_KEY).length;
  settleMode = "fail";
  const payer = "0x2222222222222222222222222222222222222222";
  const r = await app.request(`/signals/${trader}`, { headers: { "X-PAYMENT": xPaymentFor(payer) } });
  assert.equal(r.status, 402, `settle 失敗必須回 402，got ${r.status}`);
  const after = listFor(QUEUE_KEY).length;
  assert.equal(after, before, "settle 失敗時絕對不能記帳——買方沒被扣款");
  console.log("facilitator settle 失敗 → 402，且未記帳 ✓");
}

// ── 3) /oracle 走同一條路，記帳對象是 resolveTrader() 的受益人 ───────────────
{
  settleMode = "success";
  const before = listFor(QUEUE_KEY).length;
  const payer = "0x3333333333333333333333333333333333333333";
  const r = await app.request(`/oracle/sBTC`, { headers: { "X-PAYMENT": xPaymentFor(payer) } });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${await r.clone().text()}`);
  const j = (await r.json()) as { settled: boolean };
  assert.equal(j.settled, true);
  const after = listFor(QUEUE_KEY);
  assert.equal(after.length, before + 1);
  const entry = JSON.parse(after[after.length - 1]!) as { feeUsd: number; source: string };
  assert.equal(entry.feeUsd, 0.005);
  assert.equal(entry.source, "oracle");
  console.log("/oracle settle 成功 → 記帳一筆（source=oracle）✓");
}

// ── 4) ledger 未設定（Upstash 憑證缺）→ settled:false + 明確 settleError ──────
{
  settleMode = "success";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const payer = "0x4444444444444444444444444444444444444444";
  const r = await app.request(`/signals/${trader}`, { headers: { "X-PAYMENT": xPaymentFor(payer) } });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; settled: boolean; settleError?: string };
  assert.equal(j.ok, true, "ledger 沒設定不影響資料交付——買方已付款，資料照給");
  assert.equal(j.settled, false);
  assert.ok(j.settleError?.includes("UPSTASH"), `settleError 應點名缺的 env，got: ${j.settleError}`);
  console.log("ledger 未設定 → 資料照給、settled:false、settleError 點名缺的 env ✓");
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${upstashPort}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
}

await new Promise<void>((r) => facilitator.close(() => r()));
await new Promise<void>((r) => upstash.close(() => r()));
console.log("ledgerFlow.test.ts ✓ all assertions passed");
