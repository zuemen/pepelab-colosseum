// 自測：x402 範例的 VC 閘門（verifyVcForAgent）也接受智慧帳戶（例如 Base Account）簽的 VC，免鏈免資金。
// 證明「EOA VC → 有效且不打 RPC；錢包認可的智慧帳戶 VC → 有效；錢包不認可、換 holder、RPC 失敗、缺 VC → 被拒」，
// 而同步的 localVerifyVc 行為不變（只認 ecrecover）。
//   npx tsx examples/vc-gate.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { issueAuthorizationVC, issueAuthorizationVCWithSigner, type AuthorizationCaps } from "@pepelab/shared";
import { localVerifyVc, verifyVcForAgent } from "./vc-gate.ts";

const MAGIC = "0x1626ba7e";
const ERC1271 = new ethers.Interface(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

/** A mock chain with one smart account that accepts exactly one (digest, signature) pair. */
function mockChain(smart: string, accepted: { digest: string; signature: string }) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async getCode(address: string) {
      calls++;
      return ethers.getAddress(address) === ethers.getAddress(smart) ? "0x6080604052" : "0x";
    },
    async call(tx: { to?: string | null; data?: string | null }) {
      calls++;
      const [hash, sig] = ERC1271.decodeFunctionData("isValidSignature", tx.data!);
      const ok = hash === accepted.digest && ethers.hexlify(sig) === accepted.signature;
      return ethers.AbiCoder.defaultAbiCoder().encode(["bytes4"], [ok ? MAGIC : "0xffffffff"]);
    },
  };
}

const offline = {
  async getCode(): Promise<string> {
    throw new Error("RPC unreachable");
  },
  async call(): Promise<string> {
    throw new Error("RPC unreachable");
  },
};

async function main() {
  const user = ethers.Wallet.createRandom();
  const agent = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom();
  const smartAccount = ethers.Wallet.createRandom().address; // stands in for a Base Account contract
  const SESSION_ID = 7;
  const caps: AuthorizationCaps = { maxMarginPerTrade: "50", totalBudget: "150", maxLeverage: 3, expiry: Math.floor(Date.now() / 1000) + 3600 };

  // 1) EOA 簽的 VC → 有效，而且完全不碰 RPC（provider 一被呼叫就會丟錯）
  const eoaVc = await issueAuthorizationVC({ issuer: user, agentAddress: agent.address, sessionId: SESSION_ID, caps });
  const eoa = await verifyVcForAgent(eoaVc, agent.address, SESSION_ID, offline);
  assert.equal(eoa.ok, true, eoa.reason);
  assert.deepEqual(eoa, localVerifyVc(eoaVc, agent.address, SESSION_ID));
  console.log("✓ EOA VC → 有效，不打 RPC，結果與 localVerifyVc 相同");

  // 智慧帳戶「簽」：比 65 bytes 長的簽章，如同智慧錢包的 SignatureWrapper
  let signedDigest = "";
  const smartSignature = ethers.hexlify(ethers.randomBytes(97));
  const smartVc = await issueAuthorizationVCWithSigner({
    issuerAddress: smartAccount,
    agentAddress: agent.address,
    sessionId: SESSION_ID,
    caps,
    signTypedData: async (d, t, v) => {
      signedDigest = ethers.TypedDataEncoder.hash(d, t, v);
      return smartSignature;
    },
  });
  const chain = mockChain(smartAccount, { digest: signedDigest, signature: smartSignature });

  // 2) 錢包認可 → 有效；同一張用同步 localVerifyVc → 仍被拒（舊行為不變）
  const smart = await verifyVcForAgent(smartVc, agent.address, SESSION_ID, chain);
  assert.equal(smart.ok, true, smart.reason);
  assert.ok(chain.calls > 0);
  assert.equal(localVerifyVc(smartVc, agent.address, SESSION_ID).ok, false);
  console.log("✓ Base Account 簽的 VC（ERC-1271 認可）→ 有效；localVerifyVc 仍拒絕");

  // 3) 錢包不認可（換一個簽章）→ 拒絕
  const rejectingChain = mockChain(smartAccount, { digest: signedDigest, signature: ethers.hexlify(ethers.randomBytes(97)) });
  const bad = await verifyVcForAgent(smartVc, agent.address, SESSION_ID, rejectingChain);
  assert.equal(bad.ok, false);
  console.log("✓ 錢包不認可 → 拒絕：", bad.reason);

  // 4) holder 不是本 agent、sessionId 不符 → 拒絕（ERC-1271 驗過也一樣）
  assert.equal((await verifyVcForAgent(smartVc, other.address, SESSION_ID, chain)).ok, false);
  assert.equal((await verifyVcForAgent(smartVc, agent.address, SESSION_ID + 1, chain)).ok, false);
  console.log("✓ 換 holder／錯 session → 拒絕");

  // 5) RPC 失敗 → 拒絕，不會讓程式崩潰
  const down = await verifyVcForAgent(smartVc, agent.address, SESSION_ID, offline);
  assert.equal(down.ok, false);
  console.log("✓ RPC 失敗 → 拒絕：", down.reason);

  // 6) 缺 VC → 拒絕
  assert.equal((await verifyVcForAgent(null, agent.address, SESSION_ID, chain)).ok, false);
  console.log("✓ 缺 VC → 拒絕");

  console.log("\nvc-gate：全部通過");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
