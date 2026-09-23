# PepeFi On-Chain CFD

A proof-of-concept perpetual CFD (Contract for Difference) protocol deployed on **Base Sepolia** testnet, built as an NCCU Capstone 2026 project.

## Networks

| Network | Status | Notes |
|---|---|---|
| **Base Sepolia (84532)** | ✅ Active — primary deployment | Price keeper runs via GitHub Actions |
| Sepolia (11155111) | ⚠️ Secondary — **still being fed** | `price-keeper.yml` 每 15 分鐘仍在更新它的 MockOracle + GuardedOracle |

> **2026-08-06 更正**：本表先前寫 Sepolia「Oracle no longer updated; contracts
> frozen by stale-price guard」。那是錯的 —— `.github/workflows/price-keeper.yml`
> 一直都在跑，從未停用。正確的說法是「Sepolia 不再是主要部署，但喂價仍在運作」；
> 上面所有 V2 金庫（`AssetVaultV2*`）與 GuardedOracle 的展示都依賴它活著。

## Architecture

| Layer | Component | Role |
|---|---|---|
| Core | `PerpetualExchange` | Open/close positions, margin, funding, liquidation |
| Oracle | `MockOracle` | Keeper-updated price feed (Chainlink / Pyth / Aggregator adapters available) |
| Liquidity | `InsuranceVault` | LP deposits (pIV shares), bailouts, liquidation remainder |
| Fees | `FeeRouter` | 70/20/10 split (trader / platform / vault) |
| Copy Trading | `CopyTracker` | Follow/unfollow traders, mirror positions |
| Staking | `TraderStake` | Reputation stake with slashing |
| Swap | `MockSwapRouter` | Bidirectional ETH ↔ mUSDC at 1 ETH = 3000 USDC |

## Deployed Contracts (Base Sepolia)

Source of truth: `frontend/src/contracts/addresses.ts`. This is **pepelab-colosseum's own deployment**
(2026-09-23, deployer `0xB98BA27B…3a02`); it shares no contract with the original
pepelab_onchain_cfd deployment. Details and on-chain verification: [`HACKATHON.md`](HACKATHON.md).

| Contract | Address |
|---|---|
| PerpetualExchange | `0xC45dEd77F4A30658e3c52E6fB4809E502e3D3B0E` |
| AgentSessionManager | `0x71125e25c903AD4e198e1863d5Bf26df97926CDe` |
| MockOracle | `0x7c7FD43376738151a09719Ab5B33962a77dfBb49` |
| InsuranceVault | `0x42b9503E4AEf7A347DB75E54d32230720D1dd4f0` |
| FeeRouter | `0x91E4aC532201Fc67C715Aa202B6Fe85F51b34994` |
| MockUSDC | `0x0910e965B06845BD3871860d522952a44a574058` |
| MockSwapRouter | `0xCebdae595260F31541E44FBFfC80614d8B73C87a` |
| CopyTracker | `0xF19E53dDBbD6CfDFb50deF952CA5f956ed08d0C4` |
| StrategyRegistry | `0x6Af6BEBC8fF0CE354e6E8A97921E1C5Ea95a7DE8` |
| TraderStake | `0x790fd51ad485013C5b87FD7765679461675A31FD` |
| KYCRegistry | `0x34D644b9d58c1D4B0Cb805BA49440F53Ca0378d0` |
| x402 FeeRouter (Circle USDC) | `0xEeDcEE7cD62A644EA4Cf053f213d5D75dB0B49c6` |

The exchange authorizes exactly one agent contract — the AgentSessionManager above.

## Features

- **Long / Short positions** with configurable leverage (1×–5×, per-asset overrides)
- **Funding rate** — OI-imbalance driven, 0.75% cap per 8-hour interval
  (on-chain `FUNDING_INTERVAL()` = 28800, read 2026-09-23 → 2.25%/day cap).
- **Liquidation engine** — permissionless, 5% maintenance margin, liquidator reward
- **Insurance vault** — LP shares (pIV), bailout floor, optional auto-deleveraging (ADL)
- **Copy trading** — follow a trader, positions mirror automatically, slashing on big losses
- **Trader staking** — stake ETH as reputation collateral
- **RWA / KYC gating** — flagged assets require KYC verification (opt-in)
- **Bidirectional swap** — ETH → mUSDC (mint) and mUSDC → ETH (burn + send)
- **On-chain history** — queryFilter-based event log across all contracts

## Price Keeper

Prices are pushed to `MockOracle` by a GitHub Actions workflow
(`.github/workflows/base-sepolia-keeper.yml`) on a 15-minute cron, plus a
`settleFunding` crank. The exchange rejects prices older than `maxPriceAge`
on every state-changing call.

**資料來源（2026-08-06 更正）**：本節先前寫「CoinGecko / Stooq + ±45% move
guard」，那描述的是 master 的舊版行內 bash keeper。現況是：

| 來源 | 用途 |
|---|---|
| **Pyth relay**（`AggregatorOracleAdapter 0x8215…813D`） | sBTC / sETH —— 讀鏈上去中心化預言機 |
| **Yahoo Finance** | 其餘資產（測試網沒有 Pyth feed） |
| ~~Stooq~~ | ❌ **已死** —— CI log 實證回傳 HTML 404，`parseFeedValue` 會擋下 |
| ~~CoinGecko~~ | 不再用於喂價（前端顯示仍可能用到） |

實作是單一份 `agent/keeper/run.ts`（有單元測試），偏離保護由 `core.ts` 的
`stepTowards` 處理，不是舊的 ±45% 硬閘門。

> Pyth relay 是**受信任的中繼，不是無信任的整合**：keeper 的金鑰仍可寫任何值。
> 它拿掉的是對中心化交易所 API 的依賴，不是對 keeper 的依賴。

Before a live demo, trigger the workflow manually (Actions → Base Sepolia
Keeper → Run workflow) to guarantee fresh prices.

## On-Chain Auditability

Every state-changing action emits a Solidity event. The `/history` page replays those events client-side via ethers.js `queryFilter` so anyone can verify the full activity log without trusting a backend.

```ts
// Example: fetch last 5000 blocks of PositionOpened for any user
const filter = exchange.filters.PositionOpened(null, null, null)
const logs   = await exchange.queryFilter(filter, -5000)
```

Events covered:

| Event | Contract |
|---|---|
| `SwapEthToUsdc` / `SwapUsdcToEth` | MockSwapRouter |
| `PositionOpened` / `PositionClosed` | PerpetualExchange |
| `MarginDeposited` / `MarginWithdrawn` | PerpetualExchange |
| `PositionLiquidated` / `FundingSettled` | PerpetualExchange |
| `TraderFollowed` / `TraderUnfollowed` | CopyTracker |
| `CopyFeeDistributed` | FeeRouter |
| `PriceUpdated` | MockOracle |
| `Staked` / `Slashed` | TraderStake |

## Development

```bash
# Contracts
cd contracts
forge build
forge test

# Frontend — yarn only（package.json 有 "packageManager": "yarn@1.22.22"）
# 用 npm 會產生一份沒有任何流程會驗證的 package-lock.json，且 npm 會忽略
# package.json 裡的 "resolutions"（安全 pin 就在那裡）。
cd frontend
yarn install --frozen-lockfile
yarn dev

# Agent
cd agent
npm ci
npm test
```

## Deployment (Base Sepolia)

```bash
./deploy-base-sepolia.sh
# Then update frontend/src/contracts/addresses.ts with new addresses
# Pre-fund swap router:
# cast send <SwapRouter> "fundRouter()" --value 1ether --rpc-url $BASE_SEPOLIA_RPC
```

## Design Notes / Known Trade-offs

- Liquidation currently forfeits the position's remaining collateral
  (5% to the liquidator, remainder to the InsuranceVault) instead of
  refunding the owner — intentional simplification for the prototype.
- `MockUSDC.mint` is owner/swap-router only (audit PA-3); users get test
  margin from `faucet()` — 1,000 mUSDC per address per 24 h, EOAs only.
- ADL and portfolio margin are opt-in flags, off by default.

## Stack

- Solidity 0.8.20 + Foundry (OpenZeppelin v5)
- React 19 + TypeScript + Vite + MUI
- ethers.js v6
- MetaMask (EIP-1193)

## Security Status

本專案於 2026-08-06 做過一次全面稽核，結果與待辦清單在
[`docs/audit/AUDIT_2026-08-06.md`](docs/audit/AUDIT_2026-08-06.md)。

**pepelab-colosseum 部署的現況（2026-09-23）：**

1. 本 repo 的合約由全新金鑰部署，owner 是 `0xB98BA27B…3a02`。稽核提到的舊 deployer 私鑰
   （曾出現在 git 歷史中，2026-08-07 已輪替）**不擁有本 repo 任何合約**。
   該段 git 歷史因完整匯入而仍存在於本 repo，請勿使用其中任何金鑰。
2. `MockUSDC.mint` 只限 owner 與 swap router（稽核 PA-3）；一般使用者走 `faucet()`（每地址 24 小時 1,000 mUSDC）
3. `PepeAMM` 未在本 repo 部署

## Disclaimer

Research prototype · NCCU Capstone 2026 · No real assets · 僅供學術展示，非投資建議
