// Top up a Base Account's margin from a Base Spend Permission, through SpendPermissionMarginFunder
// (contracts/src/SpendPermissionMarginFunder.sol). Two limits, two layers: the Spend Permission caps
// how much of the margin token can leave the wallet per period; the session caps what the agent does
// with the margin. The agent must hold the user's authorization VC for the session, verified and
// cross-checked on chain exactly as for opening a position.
import { ethers } from "ethers";
import { ADDRESSES } from "./addresses.ts";
import { makeProvider, makeSigner, makeSessionManager } from "./provider.ts";
import { verifyVcAgainstChain, type WriteResult } from "./write.ts";
import type { AuthorizationVC } from "./identity.ts";

/** A SpendPermission as JSON (big numbers as decimal strings), as a wallet or app would pass it. */
export interface SpendPermissionJson {
  account: string;
  spender: string;
  token: string;
  allowance: string; // uint160, base units
  period: number; // seconds
  start: number; // unix seconds
  end: number; // unix seconds
  salt: string; // uint256
  extraData: string; // bytes
}

const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);

/**
 * Checks that can be made before sending. SpendPermissionManager enforces the approval, the
 * window and the per-period allowance on chain; this only refuses requests that are wrong on
 * their face, so the agent does not pay gas for a certain revert.
 * @returns null if the request is well formed, otherwise the reason.
 */
export function validateTopUp(
  p: SpendPermissionJson,
  ctx: { funder: string; marginToken: string; sessionUser: string; amount: bigint },
): string | null {
  if (!same(p.spender, ctx.funder)) return `permission spender ${p.spender} is not the funder ${ctx.funder}`;
  if (!same(p.token, ctx.marginToken)) return `permission token ${p.token} is not the margin token ${ctx.marginToken}`;
  if (!same(p.account, ctx.sessionUser)) return `permission account ${p.account} is not the session user ${ctx.sessionUser}`;
  if (ctx.amount <= 0n) return "amount must be positive";
  if (ctx.amount > BigInt(p.allowance)) return `amount ${ctx.amount} is above the per-period allowance ${p.allowance}`;
  return null;
}

/** The struct as an ordered tuple, matching SpendPermissionManager.SpendPermission. */
export function permissionTuple(p: SpendPermissionJson) {
  return [
    ethers.getAddress(p.account),
    ethers.getAddress(p.spender),
    ethers.getAddress(p.token),
    BigInt(p.allowance),
    BigInt(p.period),
    BigInt(p.start),
    BigInt(p.end),
    BigInt(p.salt),
    p.extraData,
  ] as const;
}

const FUNDER_ABI = [
  "function topUp((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData) permission, uint160 amount)",
];

/** Address of the deployed funder, or null (it is not deployed by default). */
export function getFunderAddress(): string | null {
  const a = process.env.SPEND_PERMISSION_FUNDER_ADDRESS?.trim();
  return a && ethers.isAddress(a) ? ethers.getAddress(a) : null;
}

/**
 * Move `amountUsdc` (human units, 18-decimal margin token) from the session user's Base Account
 * into their margin on the exchange. Requires AGENT_PRIVATE_KEY, SESSION_MANAGER_ADDRESS,
 * SPEND_PERMISSION_FUNDER_ADDRESS and the user's authorization VC for the session.
 */
export async function topUpMargin(params: {
  sessionId: number;
  permission: SpendPermissionJson;
  amountUsdc: number;
  authVc: AuthorizationVC;
}): Promise<WriteResult> {
  const funderAddr = getFunderAddress();
  if (!funderAddr) {
    return { ok: false, error: "SPEND_PERMISSION_FUNDER_ADDRESS is not set: the funder is not deployed (see docs/design/SPEND_PERMISSIONS.md)." };
  }
  const provider = makeProvider();
  const signer = makeSigner(provider);
  if (!signer) return { ok: false, error: "AGENT_PRIVATE_KEY is not set (0x + 64 hex)." };
  const mgr = makeSessionManager(signer);
  if (!mgr) return { ok: false, error: "SESSION_MANAGER_ADDRESS is not set." };

  const vcError = await verifyVcAgainstChain(params.authVc, params.sessionId, await signer.getAddress(), mgr);
  if (vcError) return { ok: false, error: vcError, sessionId: params.sessionId };

  const session = await mgr.sessions(params.sessionId);
  const amount = ethers.parseUnits(String(params.amountUsdc), 18);
  const invalid = validateTopUp(params.permission, {
    funder: funderAddr,
    marginToken: ADDRESSES.MockUSDC,
    sessionUser: session.user as string,
    amount,
  });
  if (invalid) return { ok: false, error: invalid, sessionId: params.sessionId };

  try {
    const funder = new ethers.Contract(funderAddr, FUNDER_ABI, signer);
    const tx = await funder.topUp(permissionTuple(params.permission), amount);
    const receipt = await tx.wait();
    return { ok: true, txHash: tx.hash, sessionId: params.sessionId, detail: { blockNumber: receipt?.blockNumber, amountUsdc: params.amountUsdc } };
  } catch (err) {
    return { ok: false, error: (err as Error).message, sessionId: params.sessionId };
  }
}
