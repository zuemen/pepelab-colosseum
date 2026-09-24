// End-to-end run on Base Sepolia: a Base Account (Coinbase Smart Wallet) funds an agent's
// trading mandate through a Base Spend Permission.
//
//   ① User creates a Base Account (owners: the user's key and Coinbase's SpendPermissionManager)
//   ② User moves margin tokens into it
//   ③ Base Account, one batch: approve a Spend Permission (≤100 mUSDC per day to the funder),
//      name the agent as top-up agent, open a capped session for the agent
//   ④ Base Account signs the authorization credential (ERC-1271), verified against the chain
//   ⑤ Agent tops up 60 mUSDC of margin → credited to the Base Account's margin
//   ⑥ Agent tries 50 more the same day (110 > 100) → mined and reverted by SpendPermissionManager
//   ⑦ Agent opens a position inside the session caps with the Base Account's credential
//
// Needs (agent/.env): BASE_SEPOLIA_RPC_URL, USER_PRIVATE_KEY, AGENT_PRIVATE_KEY,
// SPEND_PERMISSION_FUNDER_ADDRESS. Writes demo/SPEND_PERMISSIONS_RUN.md and
// frontend/src/lib/pepefi/spendPermissionRun.json.
//   cd agent && npx tsx examples/spend-permission-demo.ts
import { ethers } from "ethers";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDRESSES,
  assetIdOf,
  issueAuthorizationVCWithSigner,
  verifyAuthorizationVCWithProvider,
  topUpMargin,
  openPositionForSession,
  type AuthorizationCaps,
  type SpendPermissionJson,
} from "@pepelab/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const RPC = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
const SESSION_MANAGER = process.env.SESSION_MANAGER_ADDRESS?.trim() || "0x71125e25c903AD4e198e1863d5Bf26df97926CDe";
process.env.SESSION_MANAGER_ADDRESS = SESSION_MANAGER;

const SPEND_PERMISSION_MANAGER = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
const SMART_WALLET_FACTORY = "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a";
const ALLOWANCE = 100;   // mUSDC per period
const PERIOD = 86_400;   // one day
const FUND = 300;        // mUSDC moved into the Base Account
const TOP_UP = 60;
const OVER_TOP_UP = 50;  // 60 + 50 > 100 in the same period
const CAP_PER_TRADE = 50, CAP_BUDGET = 150, CAP_LEVERAGE = 3;
const TRADE_MARGIN = 20, TRADE_LEVERAGE = 2;

const basescan = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`set ${k}=0x… (Base Sepolia test key)`);
  return v;
};

interface Step { n: string; actor: string; action: string; tx: string | null; result: string }
const steps: Step[] = [];
const log = (s: Step) => {
  steps.push(s);
  console.log(`${s.n} [${s.actor}] ${s.action}\n    → ${s.result}${s.tx ? `\n    ${basescan(s.tx)}` : ""}`);
};

let PROVIDER: ethers.JsonRpcProvider;
/** Load-balanced public RPC: after each receipt, wait until three reads show a later block. */
async function settleBlock(blockNumber: number): Promise<void> {
  for (let ok = 0; ok < 3;) {
    ok = (await PROVIDER.getBlockNumber()) > blockNumber ? ok + 1 : 0;
    if (ok < 3) await new Promise((r) => setTimeout(r, 700));
  }
}
async function settled(tx: ethers.TransactionResponse): Promise<ethers.TransactionReceipt> {
  const rc = await tx.wait();
  if (!rc) throw new Error("no receipt");
  await settleBlock(rc.blockNumber);
  return rc;
}
async function settledHash(hash: string): Promise<void> {
  const rc = await PROVIDER.waitForTransaction(hash);
  if (rc) await settleBlock(rc.blockNumber);
}

const FACTORY_ABI = [
  "function createAccount(bytes[] owners, uint256 nonce) payable returns (address)",
  "function getAddress(bytes[] owners, uint256 nonce) view returns (address)",
];
const WALLET_ABI = [
  "function executeBatch((address target,uint256 value,bytes data)[] calls) payable",
  "function replaySafeHash(bytes32 hash) view returns (bytes32)",
];
const PERMISSION_TUPLE = "(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)";
const SPM_IFACE = new ethers.Interface([
  `function approve(${PERMISSION_TUPLE} spendPermission) returns (bool)`,
  "error ExceededSpendPermission(uint256 value, uint256 allowance)",
]);
const FUNDER_IFACE = new ethers.Interface([
  `function topUp(${PERMISSION_TUPLE} permission, uint160 amount)`,
  "function setTopUpAgent(address agent)",
  "error ExceededSpendPermission(uint256 value, uint256 allowance)",
]);
const ASM_IFACE = new ethers.Interface([
  "function createSessionWithAssets(address agent,uint256 maxMarginPerTrade,uint256 totalMarginBudget,uint256 maxLeverage,uint256 expiry,bytes32[] allowedAssets) returns (uint256)",
  "function nextSessionId() view returns (uint256)",
]);

async function main() {
  PROVIDER = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const user = new ethers.Wallet(need("USER_PRIVATE_KEY"), PROVIDER);
  const agent = new ethers.Wallet(need("AGENT_PRIVATE_KEY"), PROVIDER);
  const funderAddr = process.env.SPEND_PERMISSION_FUNDER_ADDRESS?.trim();
  if (!funderAddr || !ethers.isAddress(funderAddr)) throw new Error("set SPEND_PERMISSION_FUNDER_ADDRESS");
  const funder = ethers.getAddress(funderAddr);
  const usdc = new ethers.Contract(ADDRESSES.MockUSDC, ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], user);
  const exchange = new ethers.Contract(ADDRESSES.PerpetualExchange, ["function freeMargin(address) view returns (uint256)"], PROVIDER);
  const asm = new ethers.Contract(SESSION_MANAGER, ASM_IFACE, PROVIDER);
  console.log(`User ${user.address} · Agent ${agent.address} · Funder ${funder}\n`);

  // ① Base Account ────────────────────────────────────────────────────────────
  const owners = [ethers.AbiCoder.defaultAbiCoder().encode(["address"], [user.address]), ethers.AbiCoder.defaultAbiCoder().encode(["address"], [SPEND_PERMISSION_MANAGER])];
  const nonce = BigInt(ethers.id("pepelab-spend-permission-demo"));
  const factory = new ethers.Contract(SMART_WALLET_FACTORY, FACTORY_ABI, user);
  // factory.getAddress would hit ethers' own Contract.getAddress(); call the factory function explicitly.
  const account = ethers.getAddress(await factory.getFunction("getAddress")(owners, nonce));
  if ((await PROVIDER.getCode(account)) === "0x") {
    const t = await factory.createAccount(owners, nonce);
    await settled(t);
    log({ n: "①", actor: "User", action: "create a Base Account (Coinbase Smart Wallet; owners: user key + SpendPermissionManager)", tx: t.hash, result: `account ${account}` });
  } else {
    log({ n: "①", actor: "User", action: "Base Account (Coinbase Smart Wallet) already created", tx: null, result: `account ${account}` });
  }
  const wallet = new ethers.Contract(account, WALLET_ABI, user);

  // ② Margin tokens into the Base Account ───────────────────────────────────────
  const fund = ethers.parseUnits(String(FUND), 18);
  if ((await usdc.balanceOf(account)) < fund) {
    const t = await usdc.transfer(account, fund);
    await settled(t);
    log({ n: "②", actor: "User", action: `move ${FUND} mUSDC into the Base Account`, tx: t.hash, result: "wallet funded" });
  }

  // ③ One batch from the Base Account ───────────────────────────────────────────
  const now = (await PROVIDER.getBlock("latest"))!.timestamp;
  const permission: SpendPermissionJson = {
    account, spender: funder, token: ADDRESSES.MockUSDC,
    allowance: ethers.parseUnits(String(ALLOWANCE), 18).toString(),
    period: PERIOD, start: now - 60, end: 281474976710655, salt: String(BigInt(ethers.id(`salt-${now}`)) % 2n ** 64n), extraData: "0x",
  };
  const permTuple = [permission.account, permission.spender, permission.token, BigInt(permission.allowance), permission.period, permission.start, permission.end, BigInt(permission.salt), permission.extraData];
  const expiry = now + 7 * 86_400;
  const sessionId = Number(await asm.nextSessionId());
  const calls = [
    { target: SPEND_PERMISSION_MANAGER, value: 0n, data: SPM_IFACE.encodeFunctionData("approve", [permTuple]) },
    { target: funder, value: 0n, data: FUNDER_IFACE.encodeFunctionData("setTopUpAgent", [agent.address]) },
    { target: SESSION_MANAGER, value: 0n, data: ASM_IFACE.encodeFunctionData("createSessionWithAssets", [
      agent.address, ethers.parseUnits(String(CAP_PER_TRADE), 18), ethers.parseUnits(String(CAP_BUDGET), 18), CAP_LEVERAGE, expiry,
      [assetIdOf("sBTC"), assetIdOf("sETH")],
    ]) },
  ];
  const t3 = await wallet.executeBatch(calls);
  await settled(t3);
  log({ n: "③", actor: "Base Account", action: `one batch: approve a Spend Permission (≤ ${ALLOWANCE} mUSDC per day, spender = funder), name the agent as top-up agent, open session #${sessionId} (${CAP_PER_TRADE} per trade, ${CAP_BUDGET} budget, ${CAP_LEVERAGE}x, sBTC/sETH, 7 days)`, tx: t3.hash, result: `permission approved; session #${sessionId}` });

  // ④ Authorization credential signed by the Base Account (ERC-1271) ────────────
  const caps: AuthorizationCaps = { maxMarginPerTrade: String(CAP_PER_TRADE), totalBudget: String(CAP_BUDGET), maxLeverage: CAP_LEVERAGE, expiry };
  const vc = await issueAuthorizationVCWithSigner({
    issuerAddress: account, agentAddress: agent.address, sessionId, caps,
    signTypedData: async (d, t, v) => {
      // Coinbase Smart Wallet: the owner signs the wallet's replay-safe hash of the EIP-712 digest,
      // wrapped as SignatureWrapper(ownerIndex, signatureData). ownerIndex 0 = the user's key.
      const digest = ethers.TypedDataEncoder.hash(d, t, v);
      const safe = await wallet.replaySafeHash(digest);
      const sig = user.signingKey.sign(safe).serialized;
      return ethers.AbiCoder.defaultAbiCoder().encode(["tuple(uint256 ownerIndex, bytes signatureData)"], [[0, sig]]);
    },
  });
  const check = await verifyAuthorizationVCWithProvider(vc, PROVIDER);
  if (!check.valid) throw new Error(`credential did not verify: ${check.reason}`);
  log({ n: "④", actor: "Base Account", action: "sign the EIP-712 authorization credential (ERC-1271 smart-account signature)", tx: null, result: "valid: the Base Account's isValidSignature accepted it" });

  // ⑤ Agent tops up margin through the Spend Permission ─────────────────────────
  const marginBefore = await exchange.freeMargin(account);
  const r5 = await topUpMargin({ sessionId, permission, amountUsdc: TOP_UP, authVc: vc });
  if (!r5.ok || !r5.txHash) throw new Error(`top-up failed: ${r5.error}`);
  await settledHash(r5.txHash);
  const marginAfter = await exchange.freeMargin(account);
  log({ n: "⑤", actor: "Agent", action: `top up ${TOP_UP} mUSDC through the Spend Permission`, tx: r5.txHash, result: `Base Account margin ${ethers.formatUnits(marginBefore, 18)} → ${ethers.formatUnits(marginAfter, 18)} mUSDC` });

  // ⑥ Over the per-period allowance, forced on chain ────────────────────────────
  const funderAsAgent = new ethers.Contract(funder, FUNDER_IFACE, agent);
  const over = ethers.parseUnits(String(OVER_TOP_UP), 18);
  let reason = "unknown";
  try {
    await funderAsAgent.topUp.staticCall(permTuple, over);
    reason = "static call did NOT revert";
  } catch (e) {
    const err = e as { revert?: { name?: string }; shortMessage?: string };
    reason = err.revert?.name ?? err.shortMessage ?? String(e);
  }
  const t6 = await funderAsAgent.topUp(permTuple, over, { gasLimit: 400_000n });
  let status = 0;
  try { status = (await t6.wait())?.status ?? 0; } catch { status = 0; }
  await settledHash(t6.hash);
  log({ n: "⑥", actor: "Agent", action: `top up ${OVER_TOP_UP} more the same day (${TOP_UP + OVER_TOP_UP} > ${ALLOWANCE})`, tx: t6.hash, result: status === 1 ? `UNEXPECTED SUCCESS (${reason})` : `reverted on chain: ${reason}` });

  // ⑦ Trade inside the caps with the Base Account's credential ──────────────────
  const r7 = await openPositionForSession({ sessionId, symbol: "sBTC", isLong: true, marginUsdc: TRADE_MARGIN, leverage: TRADE_LEVERAGE, authVc: vc });
  if (!r7.ok || !r7.txHash) throw new Error(`open failed: ${r7.error}`);
  await settledHash(r7.txHash);
  log({ n: "⑦", actor: "Agent", action: `openPositionForSession(#${sessionId}, sBTC, long, ${TRADE_MARGIN}, ${TRADE_LEVERAGE}x) with the Base Account's credential`, tx: r7.txHash, result: `position #${r7.positionId}` });

  // ── Record ────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString();
  const md = [
    "# Demo run — Base Account + Spend Permission + agent session",
    "",
    `Generated by \`agent/examples/spend-permission-demo.ts\` at ${stamp} on Base Sepolia. Every row with a transaction can be checked on BaseScan.`,
    "",
    `- Base Account (Coinbase Smart Wallet): \`${account}\`, owned by the user key \`${user.address}\` and Coinbase's SpendPermissionManager \`${SPEND_PERMISSION_MANAGER}\``,
    `- Agent: \`${agent.address}\` · SpendPermissionMarginFunder: \`${funder}\` · AgentSessionManager: \`${SESSION_MANAGER}\``,
    `- Spend Permission: at most ${ALLOWANCE} mUSDC per day may leave the Base Account, only to the funder, which credits it to the Base Account's own margin`,
    `- Session #${sessionId}: ${CAP_PER_TRADE} mUSDC per trade · ${CAP_BUDGET} mUSDC budget · ${CAP_LEVERAGE}x · sBTC, sETH · 7 days`,
    "",
    "| Step | Actor | Action | Result | Transaction |",
    "|---|---|---|---|---|",
    ...steps.map((s) => `| ${s.n} | ${s.actor} | ${s.action} | ${s.result} | ${s.tx ? `[${s.tx.slice(0, 10)}…](${basescan(s.tx)})` : "off-chain"} |`),
    "",
    "Two limits, two layers: the Spend Permission bounds how much margin can leave the wallet per day (step ⑥ is refused by SpendPermissionManager); the session bounds what the agent does with the margin (per-trade size, budget, leverage, assets, expiry).",
    "",
    "Step ⑥ is sent with an explicit gas limit so the refusal is mined on chain. Replay: `cd agent && npx tsx examples/spend-permission-demo.ts` (see the header of that file).",
    "",
  ].join("\n");
  writeFileSync(resolve(REPO, "demo/SPEND_PERMISSIONS_RUN.md"), md);
  writeFileSync(resolve(REPO, "frontend/src/lib/pepefi/spendPermissionRun.json"), JSON.stringify({
    generatedAt: stamp, account, owner: user.address, agent: agent.address, funder,
    spendPermissionManager: SPEND_PERMISSION_MANAGER, sessionManager: SESSION_MANAGER, sessionId,
    allowance: ALLOWANCE, periodSeconds: PERIOD, steps,
  }, null, 2) + "\n");
  console.log("\nWrote demo/SPEND_PERMISSIONS_RUN.md");
}

main().catch((e) => { console.error("spend-permission-demo failed:", (e as Error)?.message ?? e); process.exit(1); });
