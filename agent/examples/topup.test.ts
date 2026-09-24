// 自測：Spend Permission 儲值請求在送鏈前的檢查（純函式，免鏈免資金）。
//   npx tsx examples/topup.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { validateTopUp, permissionTuple, type SpendPermissionJson } from "@pepelab/shared";

const account = ethers.Wallet.createRandom().address; // the user's Base Account (= session.user)
const funder = ethers.Wallet.createRandom().address;
const marginToken = ethers.Wallet.createRandom().address;

const permission: SpendPermissionJson = {
  account,
  spender: funder,
  token: marginToken,
  allowance: ethers.parseUnits("100", 18).toString(),
  period: 86400,
  start: 1_790_000_000,
  end: 281474976710655,
  salt: "0",
  extraData: "0x",
};
const ctx = { funder, marginToken, sessionUser: account };
const amt = (x: string) => ethers.parseUnits(x, 18);

// 1) 合法請求 → null
assert.equal(validateTopUp(permission, { ...ctx, amount: amt("60") }), null);
console.log("✓ 合法儲值請求通過");

// 2) spender 不是 funder → 拒絕
assert.match(validateTopUp({ ...permission, spender: ethers.Wallet.createRandom().address }, { ...ctx, amount: amt("1") }) ?? "", /spender/);
console.log("✓ spender 不是 funder → 拒絕");

// 3) 代幣不是保證金代幣 → 拒絕
assert.match(validateTopUp({ ...permission, token: ethers.Wallet.createRandom().address }, { ...ctx, amount: amt("1") }) ?? "", /token/);
console.log("✓ 代幣不是保證金代幣 → 拒絕");

// 4) 帳戶不是 session.user → 拒絕（agent 不能替別人的錢包儲值到這個 session 的使用者）
assert.match(validateTopUp({ ...permission, account: ethers.Wallet.createRandom().address }, { ...ctx, amount: amt("1") }) ?? "", /session/);
console.log("✓ 帳戶不是 session.user → 拒絕");

// 5) 金額 0 或超過每期額度 → 拒絕（額度真正由 SpendPermissionManager 強制，這裡只是先擋明顯的錯）
assert.match(validateTopUp(permission, { ...ctx, amount: 0n }) ?? "", /amount/);
assert.match(validateTopUp(permission, { ...ctx, amount: amt("101") }) ?? "", /allowance/);
console.log("✓ 金額 0 或超過額度 → 拒絕");

// 6) 地址大小寫不影響比對
assert.equal(validateTopUp({ ...permission, account: account.toLowerCase(), spender: funder.toLowerCase() }, { ...ctx, amount: amt("1") }), null);
console.log("✓ 地址大小寫不影響比對");

// 7) 轉成合約呼叫用的 tuple：欄位順序與 SpendPermissionManager.SpendPermission 一致
const t = permissionTuple(permission);
assert.deepEqual(t.slice(0, 3), [ethers.getAddress(account), ethers.getAddress(funder), ethers.getAddress(marginToken)]);
assert.equal(t[3], amt("100"));
assert.deepEqual(t.slice(4, 7), [86400n, 1_790_000_000n, 281474976710655n]);
assert.equal(t[7], 0n);
assert.equal(t[8], "0x");
console.log("✓ permissionTuple 欄位順序正確");

console.log("topup.test.ts ✓ all assertions passed");
