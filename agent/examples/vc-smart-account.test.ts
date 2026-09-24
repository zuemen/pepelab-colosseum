// 自測：智慧帳戶（例如 Base Account）簽發的授權 VC 走 ERC-1271 驗證，免鏈免資金。
// 證明「錢包認可的簽章 → 有效 ✅；竄改內容、錢包不認可、非合約地址、過期、錯鏈 → 被拒 ❌」，
// 而一般 EOA 的驗證路徑完全不變。
//   npx tsx examples/vc-smart-account.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import {
  issueAuthorizationVC,
  issueAuthorizationVCWithSigner,
  verifyAuthorizationVC,
  verifyAuthorizationVCWithProvider,
  type AuthorizationCaps,
  type AuthorizationVC,
} from "@pepelab/shared";

const MAGIC = "0x1626ba7e";
const ERC1271 = new ethers.Interface(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

/** A mock chain with one smart account that accepts exactly one (digest, signature) pair. */
function mockChain(smart: string, accepted: { digest: string; signature: string }, opts: { revert?: boolean } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async getCode(address: string) {
      return ethers.getAddress(address) === ethers.getAddress(smart) ? "0x6080604052" : "0x";
    },
    async call(tx: { to?: string | null; data?: string | null }) {
      calls++;
      if (opts.revert) throw new Error("execution reverted");
      const [hash, sig] = ERC1271.decodeFunctionData("isValidSignature", tx.data!);
      const ok = hash === accepted.digest && ethers.hexlify(sig) === accepted.signature;
      return ethers.AbiCoder.defaultAbiCoder().encode(["bytes4"], [ok ? MAGIC : "0xffffffff"]);
    },
  };
}

async function main() {
  const agent = ethers.Wallet.createRandom();
  const smartAccount = ethers.Wallet.createRandom().address; // stands in for a Base Account contract
  const caps: AuthorizationCaps = { maxMarginPerTrade: "50", totalBudget: "150", maxLeverage: 3, expiry: Math.floor(Date.now() / 1000) + 3600 };
  const SESSION_ID = 3;

  // The smart account "signs": a signature longer than 65 bytes, as smart wallets produce.
  let signedDigest = "";
  const smartSignature = ethers.hexlify(ethers.randomBytes(97));
  const vc: AuthorizationVC = await issueAuthorizationVCWithSigner({
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

  // 1) 錢包認可 → 有效，issuer 是智慧帳戶
  const ok = await verifyAuthorizationVCWithProvider(vc, chain);
  assert.equal(ok.valid, true, ok.reason);
  assert.equal(ok.issuer, ethers.getAddress(smartAccount));
  console.log("✓ 智慧帳戶簽的 VC（ERC-1271 認可）→ 有效");

  // 2) 同一張 VC 用只懂 ecrecover 的同步驗證 → 仍然無效（舊行為不變）
  assert.equal(verifyAuthorizationVC(vc).valid, false);
  console.log("✓ 同步 verifyAuthorizationVC 不接受智慧帳戶簽章（行為不變）");

  // 3) 竄改上限 → 摘要改變 → 錢包不認可 → 無效
  const tampered = structuredClone(vc);
  tampered.credentialSubject.authorization.maxLeverage = 50;
  const bad = await verifyAuthorizationVCWithProvider(tampered, chain);
  assert.equal(bad.valid, false);
  console.log("✓ 竄改 VC → 錢包不認可 → 拒絕：", bad.reason);

  // 4) 錢包呼叫 revert → 無效（不往外拋）
  const reverting = mockChain(smartAccount, { digest: signedDigest, signature: smartSignature }, { revert: true });
  const bad2 = await verifyAuthorizationVCWithProvider(vc, reverting);
  assert.equal(bad2.valid, false);
  console.log("✓ isValidSignature revert → 拒絕：", bad2.reason);

  // 5) 簽發者不是合約、簽章又對不上 → 無效，而且不會去呼叫 isValidSignature
  const eoaIssuerChain = mockChain(ethers.Wallet.createRandom().address, { digest: signedDigest, signature: smartSignature });
  const bad3 = await verifyAuthorizationVCWithProvider(vc, eoaIssuerChain);
  assert.equal(bad3.valid, false);
  assert.equal(eoaIssuerChain.calls, 0);
  console.log("✓ 非合約簽發者 → 拒絕，未呼叫 ERC-1271");

  // 6) 錯鏈 DID → 在任何鏈上呼叫之前就被拒
  const wrongChain = structuredClone(vc);
  wrongChain.issuer = wrongChain.issuer.replace(/^did:pkh:eip155:\d+:/, "did:pkh:eip155:1:");
  const chain6 = mockChain(smartAccount, { digest: signedDigest, signature: smartSignature });
  const bad4 = await verifyAuthorizationVCWithProvider(wrongChain, chain6);
  assert.equal(bad4.valid, false);
  assert.equal(chain6.calls, 0);
  console.log("✓ 錯鏈 DID → 拒絕，未呼叫 ERC-1271");

  // 7) 過期 → 無效（即使錢包認可）
  let expiredDigest = "";
  const expiredVc = await issueAuthorizationVCWithSigner({
    issuerAddress: smartAccount,
    agentAddress: agent.address,
    sessionId: SESSION_ID,
    caps: { ...caps, expiry: Math.floor(Date.now() / 1000) - 10 },
    signTypedData: async (d, t, v) => {
      expiredDigest = ethers.TypedDataEncoder.hash(d, t, v);
      return smartSignature;
    },
  });
  const bad5 = await verifyAuthorizationVCWithProvider(expiredVc, mockChain(smartAccount, { digest: expiredDigest, signature: smartSignature }));
  assert.equal(bad5.valid, false);
  assert.match(bad5.reason ?? "", /expired/);
  console.log("✓ 過期 VC → 拒絕");

  // 8) 一般 EOA 簽的 VC → 有效，而且完全不碰鏈
  const user = ethers.Wallet.createRandom();
  const eoaVc = await issueAuthorizationVC({ issuer: user, agentAddress: agent.address, sessionId: SESSION_ID, caps });
  const eoaChain = mockChain(smartAccount, { digest: signedDigest, signature: smartSignature });
  const ok2 = await verifyAuthorizationVCWithProvider(eoaVc, eoaChain);
  assert.equal(ok2.valid, true, ok2.reason);
  assert.equal(eoaChain.calls, 0);
  console.log("✓ EOA 簽的 VC → 有效，未呼叫 ERC-1271");

  console.log("vc-smart-account.test.ts ✓ all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
