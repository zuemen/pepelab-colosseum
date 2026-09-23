# Base mainnet — small-scale deployment evaluation

Status: **evaluation only. Nothing has been deployed to mainnet.** Any mainnet transaction needs explicit approval from the project owner.
Date: 2026-09-23.

## Question

Would a small Base mainnet deployment with tiny USDC amounts strengthen the "real Base integration" claim, and what is the safe scope?

## Recommendation

Deploy **only the x402 revenue layer** to mainnet: the signal API taking real USDC at sub-cent prices, plus an x402 FeeRouter bound to mainnet USDC. **Do not deploy the perpetual exchange or the session manager to mainnet** for this submission.

| Component | Mainnet? | Why |
|---|---|---|
| x402 signal API + x402 FeeRouter | **Yes, if approved** | Holds no user deposits. It only routes fees the seller already received. Worst case is the loss of fees in the router. Proves real paid agent traffic on Base. |
| PerpetualExchange, InsuranceVault, AgentSessionManager | **No** | Takes user margin in real USDC against a keeper-controlled oracle; see risks 1–3 |

## Risks if the exchange went to mainnet

1. **Oracle trust.** Prices come from a MockOracle written by one keeper key. Whoever holds that key can set any price and drain the vault through liquidations or payouts. Pyth on Base Sepolia was stale when checked (2026-09-23); a production path needs a pull-oracle update flow first.
2. **Audit backlog.** The 2026-08-06 audit (`docs/audit/AUDIT_2026-08-06.md`) lists contract-level findings, including mark-price and bad-debt handling. Each must be re-verified as fixed in this repo's code before real funds are involved.
3. **Legal.** Offering leveraged CFDs on real assets to the public is a regulated activity in many jurisdictions. A hackathon demo is not the place to test that.
4. **Liquidation semantics.** The remaining collateral goes to the liquidator and the vault rather than back to the owner. That is acceptable for a prototype, but not for users' money.

## Risks for the x402-only mainnet scope, and mitigations

| Risk | Mitigation |
|---|---|
| Settlement key exposure. The current serverless design treats `FEE_SETTLEMENT_PRIVATE_KEY` as semi-public | Fresh mainnet key used only for routing. Hold ≤ 1 USDC and ≤ 0.002 ETH. Route manually or from a local worker, never from a public serverless env |
| Facilitator availability for mainnet | Verify before deploying: the facilitator currently used (x402.org) may serve testnets only. Coinbase documents its CDP facilitator on Base mainnet at $0.001 per transaction after 1,000 free per month ([docs](https://docs.cdp.coinbase.com/x402/network-support), read 2026-09-23); that needs CDP API keys |
| Price abuse / drain | Payments flow *to* the seller. The router only splits what the seller sends it. Keep prices at $0.001–0.01 and the router balance near zero |
| Accidental reuse of testnet config | Separate `.env`, separate addresses block, `X402_NETWORK=base` set explicitly; demo scripts refuse to run with a chain id other than the one configured |
| Isolation rule | Mainnet contracts are new and owned by a new key; nothing touches the original project |

## Cost estimate

Base Sepolia measurements for the same contracts (2026-09-23) put the full stack at about 20.2M gas. The x402 FeeRouter and its vault are a small fraction of that. At recent Base mainnet gas prices the x402-only deployment is expected to cost well under $1. **Read the live gas price before approving; this is not a quote.** Operating float: ≤ 1 USDC and ≤ 0.002 ETH.

## Steps (only after approval)

1. Generate a new mainnet deployer/settlement key and store it outside every repo.
2. Confirm facilitator support for `base` mainnet and obtain CDP keys if required.
3. `DeployX402Router.s.sol` with `X402_USDC` set to Base mainnet USDC; verify on BaseScan.
4. Run the signal API with `X402_NETWORK=base`. Buy one `/signals/:trader` call from a separate agent wallet funded with ≤ 0.10 USDC.
5. Route that fee with `routeExternalRevenue`. Record both transaction hashes in `HACKATHON.md`.
6. Revoke or drain: withdraw the router balance, and leave the key empty after the judging period.

## Decision needed

- [ ] Approve the x402-only mainnet scope (yes / no)
- [ ] Budget ceiling (suggested: 1 USDC + 0.002 ETH)
