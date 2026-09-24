// Agent identity & authorization — W3C Verifiable Credentials (VC) over
// Self-Sovereign Identity (SSI / DID) for "verifiable agent autonomy".
//
// SSI triangle, mapped to this project:
//   • issuer   = the user (their EOA) signs an authorization VC
//   • holder   = the AI agent (its session-key EOA), identified by a DID
//   • verifier = demo-agent / MCP server, which checks the VC signature AND
//                cross-checks it against the on-chain AgentSessionManager
//                session before executing a trade.
//
// DID method: did:pkh (W3C) — derived directly from an EVM address, so no extra
// identity infrastructure is needed: did:pkh:eip155:<chainId>:<address>.
//
// The VC = a "credentialised" view of the on-chain session authorization. It is
// signed with EIP-712 typed data using the existing ethers stack (no heavyweight
// DID/JSON-LD libraries). Verification recovers the issuer address from the
// signature and returns the authorized caps for the verifier to compare against
// the chain. Tampering with any field (caps, agent, sessionId) breaks the
// signature → verification fails → the trade is refused.
import { ethers } from "ethers";
import { AGENT_CHAIN_ID } from "./addresses.ts";
// Single source of truth for the EIP-712 schema + VC shape, shared with the
// frontend (browser-wallet issuer). Re-exported below so "@pepelab/shared"
// consumers — and the frontend, which imports the same file directly — stay
// byte-for-byte consistent. Mirrors how addresses.ts cross-imports frontend.
import {
  AUTH_DOMAIN,
  AUTH_TYPES,
  AUTH_VC_CHAIN_ID,
  buildAuthTypedValue,
  assembleAuthorizationVC,
  type AuthorizationCaps,
  type AuthorizationVC,
} from "../../../frontend/src/contracts/agentAuth";

export {
  AUTH_DOMAIN,
  AUTH_TYPES,
  AUTH_VC_CHAIN_ID,
  buildAuthTypedValue,
  assembleAuthorizationVC,
  authDid,
} from "../../../frontend/src/contracts/agentAuth";
export type { AuthorizationCaps, AuthorizationVC } from "../../../frontend/src/contracts/agentAuth";

const ZERO = "0x0000000000000000000000000000000000000000";

/** did:pkh DID for an EVM address on the agent's chain. */
export function agentDid(address: string, chainId: number = AGENT_CHAIN_ID): string {
  return `did:pkh:eip155:${chainId}:${ethers.getAddress(address)}`;
}

/** Parse a did:pkh DID back to { chainId, address }. Throws on malformed input. */
export function parseDidPkh(did: string): { chainId: number; address: string } {
  const m = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(did.trim());
  if (!m) throw new Error(`malformed did:pkh: ${did}`);
  return { chainId: Number(m[1]), address: ethers.getAddress(m[2]) };
}

// EIP-712 domain/types live in the shared agentAuth module (AUTH_DOMAIN /
// AUTH_TYPES) so the frontend signs the exact tuple this file verifies.
const DOMAIN: ethers.TypedDataDomain = AUTH_DOMAIN;
const TYPES: Record<string, ethers.TypedDataField[]> = AUTH_TYPES;

/** A connected-wallet EIP-712 signer (ethers Wallet/Signer or a wagmi adapter). */
export type TypedDataSigner = (
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: ReturnType<typeof buildAuthTypedValue>,
) => Promise<string>;

/**
 * Issue (sign) an authorization VC with a local key wallet (agent-side / tests).
 * `issuer` is the user's wallet (the EOA that created the on-chain session). The
 * credential authorizes `agentAddress` to trade within `sessionId` limited by
 * `caps`. For the browser flow (user signs in MetaMask) use
 * `issueAuthorizationVCWithSigner` instead — same schema, same output.
 */
export async function issueAuthorizationVC(params: {
  issuer: ethers.Wallet | ethers.HDNodeWallet;
  agentAddress: string;
  sessionId: number;
  caps: AuthorizationCaps;
}): Promise<AuthorizationVC> {
  const issuerAddr = await params.issuer.getAddress();
  return issueAuthorizationVCWithSigner({
    issuerAddress: issuerAddr,
    agentAddress: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    signTypedData: (d, t, v) => params.issuer.signTypedData(d, t, v),
  });
}

/**
 * Issue (sign) an authorization VC using a connected-wallet typed-data signer.
 * This is the true SSI path: the user (issuer) signs in their wallet (MetaMask),
 * so the private key never leaves the wallet. The frontend passes its connected
 * signer's `signTypedData`; agent-side `verifyAuthorizationVC` validates the
 * result. Identical schema/output to `issueAuthorizationVC`.
 */
export async function issueAuthorizationVCWithSigner(params: {
  issuerAddress: string;
  agentAddress: string;
  sessionId: number;
  caps: AuthorizationCaps;
  signTypedData: TypedDataSigner;
}): Promise<AuthorizationVC> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const value = buildAuthTypedValue({
    issuer: params.issuerAddress,
    agent: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    issuedAt,
  });
  const signature = await params.signTypedData(DOMAIN, TYPES, value);
  return assembleAuthorizationVC({
    issuerAddress: params.issuerAddress,
    agentAddress: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    issuedAt,
    signature,
  });
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  issuer?: string;       // recovered issuer address (== signer)
  agent?: string;        // holder agent address
  sessionId?: number;
  caps?: AuthorizationCaps;
}

type Prepared =
  | { error: string }
  | {
      issuer: string;
      agent: string;
      sessionId: number;
      caps: AuthorizationCaps;
      value: ReturnType<typeof buildAuthTypedValue>;
      signature: string;
    };

/** Parse a VC and run every check that does not involve the signature. */
function prepareAuthorizationVC(vc: AuthorizationVC): Prepared {
  if (!vc?.proof?.proofValue) return { error: "missing proof" };

  const issuerDid = parseDidPkh(vc.issuer);
  const agentDidParsed = parseDidPkh(vc.credentialSubject.id);
  const issuer = issuerDid.address;
  const agent = agentDidParsed.address;
  const caps = vc.credentialSubject.authorization;
  const sessionId = vc.credentialSubject.sessionId;

  // DID 的 chainId 必須綁定（稽核 四·Low）：EIP-712 簽的是「地址」，不是完整 DID，
  // 所以把 `did:pkh:eip155:84532:0x…` 改成 `eip155:1:0x…` 以前照樣 valid:true，
  // 而 vcId（proofValue 的摘要）也不變 —— 一張 Base Sepolia 的授權會被讀成
  // 主網身分。這裡明確要求兩個 DID 都在本 VC schema 綁定的鏈上。
  if (issuerDid.chainId !== AUTH_VC_CHAIN_ID) {
    return { error: `issuer DID 的 chainId(${issuerDid.chainId}) 非本 VC schema 綁定的鏈(${AUTH_VC_CHAIN_ID})` };
  }
  if (agentDidParsed.chainId !== AUTH_VC_CHAIN_ID) {
    return { error: `holder DID 的 chainId(${agentDidParsed.chainId}) 非本 VC schema 綁定的鏈(${AUTH_VC_CHAIN_ID})` };
  }

  // Reconstruct issuedAt from the proof's created timestamp (signed field).
  const issuedAt = Math.floor(new Date(vc.proof.created).getTime() / 1000);
  const value = buildAuthTypedValue({ issuer, agent, sessionId, caps, issuedAt });
  return { issuer, agent, sessionId, caps, value, signature: vc.proof.proofValue };
}

/** EOA path: does the signature recover to the issuer? (false on malformed signatures) */
function recoversToIssuer(p: Exclude<Prepared, { error: string }>): { ok: boolean; recovered?: string } {
  try {
    const recovered = ethers.verifyTypedData(DOMAIN, TYPES, p.value, p.signature);
    return { ok: recovered !== ZERO && ethers.getAddress(recovered) === ethers.getAddress(p.issuer), recovered };
  } catch {
    return { ok: false };
  }
}

function finish(p: Exclude<Prepared, { error: string }>): VerifyResult {
  const { issuer, agent, sessionId, caps } = p;
  // Expiry check (credential-level; the chain session also enforces its own).
  if (caps.expiry * 1000 < Date.now()) {
    return { valid: false, reason: "credential expired", issuer, agent, sessionId, caps };
  }
  return { valid: true, issuer, agent, sessionId, caps };
}

/**
 * Verify an authorization VC: recover the EIP-712 signer and require it to equal
 * the issuer named in the credential. Returns the authorized agent + caps so the
 * caller (verifier) can cross-check against the on-chain session.
 *
 * Any tampering (caps, agent, sessionId, issuer) changes the recovered address
 * → mismatch → `valid:false`. EOA issuers only; smart-account issuers need
 * `verifyAuthorizationVCWithProvider`.
 */
export function verifyAuthorizationVC(vc: AuthorizationVC): VerifyResult {
  try {
    const p = prepareAuthorizationVC(vc);
    if ("error" in p) return { valid: false, reason: p.error };

    const recovered = ethers.verifyTypedData(DOMAIN, TYPES, p.value, p.signature);
    if (recovered === ZERO || ethers.getAddress(recovered) !== ethers.getAddress(p.issuer)) {
      return {
        valid: false,
        reason: `signature does not match issuer (recovered ${recovered}, expected ${p.issuer})`,
      };
    }
    return finish(p);
  } catch (err) {
    return { valid: false, reason: (err as Error).message };
  }
}

/** What verifyAuthorizationVCWithProvider needs from a provider. */
export type Erc1271Reader = {
  getCode(address: string): Promise<string>;
  call(tx: { to: string; data: string }): Promise<string>;
};

const ERC1271_MAGIC = "0x1626ba7e";
const ERC1271 = new ethers.Interface(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

/**
 * Like `verifyAuthorizationVC`, and also accepts smart-account issuers such as a Base
 * Account (Coinbase Smart Wallet). When the signature does not recover to the issuer and
 * the issuer address holds code, the issuer itself is asked through ERC-1271
 * `isValidSignature(EIP-712 digest, signature)`; only the magic value 0x1626ba7e counts.
 *
 * EOA issuers never touch the chain. Every non-signature check (DID chain binding,
 * expiry) is identical. Counterfactual (not yet deployed) accounts and their ERC-6492
 * wrapped signatures are not supported: the account must be deployed.
 */
export async function verifyAuthorizationVCWithProvider(vc: AuthorizationVC, provider: Erc1271Reader): Promise<VerifyResult> {
  let p: Prepared;
  try {
    p = prepareAuthorizationVC(vc);
  } catch (err) {
    return { valid: false, reason: (err as Error).message };
  }
  if ("error" in p) return { valid: false, reason: p.error };

  const eoa = recoversToIssuer(p);
  if (eoa.ok) return finish(p);

  try {
    const code = await provider.getCode(p.issuer);
    if (!code || code === "0x") {
      return {
        valid: false,
        reason: `signature does not match issuer (recovered ${eoa.recovered ?? "nothing"}, expected ${p.issuer}), and the issuer is not a contract`,
      };
    }
    const digest = ethers.TypedDataEncoder.hash(DOMAIN, TYPES, p.value);
    const raw = await provider.call({ to: p.issuer, data: ERC1271.encodeFunctionData("isValidSignature", [digest, p.signature]) });
    const [magic] = ERC1271.decodeFunctionResult("isValidSignature", raw);
    if (String(magic).toLowerCase() !== ERC1271_MAGIC) {
      return { valid: false, reason: `the issuer contract did not accept the signature (ERC-1271 returned ${magic})` };
    }
  } catch (err) {
    return { valid: false, reason: `ERC-1271 check failed: ${(err as Error).message}` };
  }
  return finish(p);
}
