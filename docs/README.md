# Documentation index

## Start here

| Document | What it is |
|---|---|
| [`SUBMISSION.md`](SUBMISSION.md) | The Colosseum submission: problem, product, proof, Base integration, business model, go-to-market, and the development history (section 12) |
| [`../demo/RUN.md`](../demo/RUN.md) | The recorded end-to-end run on Base Sepolia, with a BaseScan link for every on-chain step |
| [`../HACKATHON.md`](../HACKATHON.md) | How this contest deployment was set up, isolated from the capstone deployment, and checked on chain |
| [`MAINNET_EVALUATION.md`](MAINNET_EVALUATION.md) | What a mainnet deployment would need (evaluation only; nothing is deployed on mainnet) |

## Design references

Most of these were written before the contest (see the development history in `SUBMISSION.md`); they describe the design rather than a particular deployment.

[`DESIGN_x402_AI_AGENT.md`](DESIGN_x402_AI_AGENT.md) · [`AGENT_IDENTITY_VC_SSI.md`](AGENT_IDENTITY_VC_SSI.md) · [`AGENT_ECONOMY_STANDARDS.md`](AGENT_ECONOMY_STANDARDS.md) · [`RISK_MODEL.md`](RISK_MODEL.md) · [`ROLE_SEPARATION.md`](ROLE_SEPARATION.md) · [`VAULT_VERSIONS.md`](VAULT_VERSIONS.md) · the ADRs (`ADR-001` to `ADR-007`) · [`audit/`](audit/)

## Inherited from the pre-contest capstone project

These were written before the contest (2026-05 to 2026-09-09) for the capstone's own deployment. **Contract addresses, test counts and run results in them refer to that earlier deployment, not to the contest deployment** listed in the main README. They are kept for history and for the development-history disclosure.

| Document | Note |
|---|---|
| [`CAPSTONE_DELIVERABLES.md`](CAPSTONE_DELIVERABLES.md) | Capstone scorecard; contains capstone-deployment addresses |
| [`DEPLOY_102_CUTOVER.md`](DEPLOY_102_CUTOVER.md), [`DEPLOY_129_CUTOVER.md`](DEPLOY_129_CUTOVER.md) | Capstone redeployments; contain capstone-deployment addresses |
| [`KEY_ROTATION_20260807.md`](KEY_ROTATION_20260807.md), [`RUNBOOK_KEY_ROTATION.md`](RUNBOOK_KEY_ROTATION.md), [`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md) | Capstone key operations; the contest deployment uses fresh keys |
| [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) | Limitations list from the capstone; some addresses refer to the capstone deployment. Current limitations: `SUBMISSION.md` section 11 |
| [`VERIFICATION_REPORT.md`](VERIFICATION_REPORT.md), [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md), [`NEXT_STEPS.md`](NEXT_STEPS.md), [`RISK_NOTES.md`](RISK_NOTES.md), `CHANGES_*.md` | Capstone-era reports and notes |
| [`RUNBOOK_KEEPER.md`](RUNBOOK_KEEPER.md), [`RUNBOOK_SITE_HEALTH.md`](RUNBOOK_SITE_HEALTH.md) | Operations runbooks written for the capstone; the contest keeper workflow is `.github/workflows/base-sepolia-keeper.yml` |
