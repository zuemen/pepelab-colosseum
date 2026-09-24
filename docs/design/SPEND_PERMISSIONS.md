# Base Spend Permissions for the cash leg (prototype, fork-tested, not deployed)

Status (2026-09-24): **deployed on Base Sepolia** at `0x20277169a755C690b98F0894EF57AF835469C9Af` and authorized on the exchange, with the owner's approval (deploy tx `0x5f6ecfa0b25cb6f7e9e61dcdeed5a3bf442c5cf9ac4d41602eb873fc4e236493`, authorize tx `0x4d07412c724e63a00bd798407f9777c28473f8b695c4488d3a45c9e52038cb4f`). Source verified on Sourcify (exact match). End-to-end run from a real Base Account: [`demo/SPEND_PERMISSIONS_RUN.md`](../../demo/SPEND_PERMISSIONS_RUN.md). Rehearsed first on a local anvil fork.

## Why

A session in `AgentSessionManager` bounds what an agent does with margin that is already on the exchange: per-trade size, cumulative budget, leverage, assets, expiry. It says nothing about how much of the user's wallet can be committed over time. A Base Spend Permission is the reverse: it bounds how much of a token can leave a Base Account per period, and knows nothing about leverage or assets. Put together, they bound both the cash that can move and what can be done with it.

## Design

`contracts/src/SpendPermissionMarginFunder.sol`

1. The user's Base Account approves a Spend Permission with `spender = SpendPermissionMarginFunder`, `token = margin token`, and an allowance per period, through Coinbase's `SpendPermissionManager` (`0xf85210B21cC50302F477BA56686d2019dC9b67Ad` on Base and Base Sepolia).
2. The user names one top-up agent with `setTopUpAgent(agent)`, typically the agent of their session.
3. The agent (or the user) calls `topUp(permission, amount)`. The funder calls `SpendPermissionManager.spend`, which enforces approval, start and end, and the per-period allowance, and moves the tokens from the Base Account to the funder. The funder immediately calls `exchange.depositMarginFor(account, amount)`.
4. The margin is credited to the account holder, never to the caller. The funder keeps no balance.

Checks in the funder itself: the caller must be the account or its top-up agent; the permission must name the funder as spender and the exchange's margin token as token.

## Evidence

`contracts/test/fork/SpendPermissionMarginFunder.fork.t.sol` runs against a fork of Base Sepolia with the real SpendPermissionManager, the real Coinbase Smart Wallet factory, and this repository's deployed exchange and MockUSDC. Run with `RUN_FORK_TESTS=true forge test --match-path test/fork/SpendPermissionMarginFunder.fork.t.sol -vv` (skipped otherwise, so CI does not depend on a public RPC).

| Test | Shows |
|---|---|
| `test_agentTopsUpWithinAllowance` | Margin is credited to the account; the agent and the funder receive nothing |
| `test_revertsAboveTheAllowanceInOnePeriod` | 60 then 50 in one period reverts with `ExceededSpendPermission` (allowance 100) |
| `test_allowanceResetsNextPeriod` | The full allowance is available again in the next period |
| `test_strangerCannotTopUp`, `test_removingTheAgentStopsItsTopUps` | Only the account or its current agent can trigger a top-up |
| `test_accountCanTopUpItself` | The account can top up without an agent |
| `test_revokedPermissionStopsTopUps` | Revoking the Spend Permission stops top-ups (`UnauthorizedSpendPermission`) |
| `test_rejectsAPermissionForAnotherToken` | A permission for another token is refused before any transfer |

8 of 8 pass (2026-09-24). Removing the caller check makes the two caller tests fail.

## What a real deployment needs (owner decisions)

1. Deploy `SpendPermissionMarginFunder(SpendPermissionManager, exchange, MockUSDC)` on Base Sepolia.
2. The exchange owner calls `setAgentAuthorized(funder, true)`, because `depositMarginFor` only accepts authorized contracts.

Both are in `contracts/script/DeploySpendPermissionFunder.s.sol` (checks the chain id and that the broadcaster owns the exchange). A fork simulation without `--broadcast` ran successfully on 2026-09-24; nothing was sent. After deploying, set `SPEND_PERMISSION_FUNDER_ADDRESS` for the agent SDK and MCP server.

**Trust change to weigh first:** the exchange's `authorizedAgents` list also allows `openPositionFor` and `closePositionFor` for any user. The funder's code never calls them, and its source can be verified, but authorizing it still adds a third contract to the list the exchange trusts (after `AgentSessionManager` and `CopyTracker`). A narrower alternative is a dedicated deposit-only role on the exchange, which would need a new exchange deployment.

## Agent side

- `agent/shared/src/topUp.ts`: `topUpMargin({ sessionId, permission, amountUsdc, authVc })` verifies the user's authorization VC and cross-checks it against the on-chain session (the same gate as opening a position), refuses requests that are wrong on their face (`validateTopUp`: spender, token, account = session user, amount within the allowance), then calls `funder.topUp`. Tests: `agent/examples/topup.test.ts`.
- MCP tool `top_up_margin` (`agent/mcp-server`), with the same required `authVcJson`.
- The session's user must be the Base Account itself for the two layers to line up. The authorization VC can now be issued by a smart account: `verifyAuthorizationVCWithProvider` accepts ERC-1271 signatures from deployed accounts (on the main branch, commit `0035d44`).

## Open items

- Frontend: no UI yet for approving the Spend Permission from a Base Account.
- Counterfactual (not yet deployed) Base Accounts: their ERC-6492 signatures are not accepted for the VC; the account must be deployed first.
- Only MockUSDC (the testnet margin token) is covered; nothing here touches mainnet.
