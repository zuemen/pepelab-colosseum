# Colosseum Crypto World's Fair — Submission Branch

> 此分支為 **Colosseum Crypto World's Fair 黑客松**參賽專用，與 `master` 的正式版本分開維護。

| Item | Value |
|---|---|
| Hackathon | [Crypto World's Fair](https://colosseum.com/worldsfair) by Colosseum |
| Target track | Base (+ University Award) |
| Submission deadline | 2026-10-12 23:59 PT（台灣時間 2026-10-13 14:59） |
| Branch | `hackathon/colosseum-worldsfair`（從 `master` @ 76e7ea4 分出） |
| Frontend version | `7.6.0-colosseum.0`（master 為 `7.5.0`） |
| Agent packages | `0.2.0`（master 為 `0.1.0`） |

## Focus for this submission
PepeLab on-chain CFD + **x402 paid API layer and autonomous AI-agent trading** (see [`docs/DESIGN_x402_AI_AGENT.md`](docs/DESIGN_x402_AI_AGENT.md) and `agent/examples/x402-*`), deployed on Base.

## Rules to remember
- All submission content must be in English.
- One team per person, one project per team.
- Judged on functionality, impact, novelty, UX, open-source composability, business plan.

## Merge policy
This repo (`zuemen/pepelab-colosseum`) is a competition-only import of `zuemen/pepelab_onchain_cfd` (imported at `5bb8be3`, full history kept). Nothing is pushed back to the original repo.

## Isolation rule — this repo never touches the original deployment
The original project's contracts on Base Sepolia stay exactly as they are. This repo:
- deploys its **own complete stack** (`contracts/script/Deploy.s.sol` — every contract is `new`, every setter targets a contract from the same run; the only external address is Pyth's public Base Sepolia contract, read-only);
- deploys its **own x402 FeeRouter** (`DeployX402Router.s.sol`);
- uses **fresh keys** that have never owned an original-project contract, and never sends a transaction to an original-project address;
- does not reuse the original project's Vercel projects, signal-api, or keeper.

Until the fresh deployment lands, `frontend/src/contracts/addresses.ts` still lists the original project's addresses — **no write script may be run against them.**

## Known issues inherited from the original repo — decisions (2026-09-23)

| # | Issue | Decision | Status |
|---|---|---|---|
| 1 | README says the deployed exchange has `FUNDING_INTERVAL = 300` s (≈216%/day at the 0.75% cap) | Resolved by the fresh deployment: this repo's exchange is compiled from current source (`8 hours`). After deploying, read `FUNDING_INTERVAL()` on-chain and record it below. (For reference: the original project's current exchange `0x827e…124D` already reads 28800 on-chain; the 300 s figure described an older exchange.) | pending deploy |
| 2 | Old `AgentSessionManager 0x5Ebcc64C…` still authorized, no per-session asset whitelist | Resolved by the fresh deployment: the new exchange only ever authorizes this repo's own session manager. After deploying, read `authorizedAgents()` for both old managers and record `false` below. (Original project: both old managers already read `false` on its current exchange.) | pending deploy |
| 3 | README numbers/addresses must match `addresses.ts` | README contract table will be regenerated from `addresses.ts` after the fresh deployment | pending deploy |
| 4 | Imported scheduled workflows have no secrets and would fail every 15 min | Disabled in this repo: Admin — Base Sepolia owner call, Base Sepolia Keeper, Oracle Health, Oracle Price Keeper (Sepolia), x402 Settlement Worker. Kept: Contracts CI, Agent CI, Frontend CI. The keeper is re-enabled only after it is pointed at this repo's own MockOracle with this repo's own keeper key. | ✅ done |

## CI baseline at import (local run, 2026-09-23)
- Agent CI: install / typecheck / tests / bundle drift check — all pass
- Frontend CI: install / build / tests — all pass (33 files, 494 tests)
- Contracts CI: `forge build --sizes` + `forge test` — all pass (79 suites, 776 tests)

Nothing was broken at import, so P0-1 needed no code fixes.
