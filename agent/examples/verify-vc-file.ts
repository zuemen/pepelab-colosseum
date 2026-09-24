// Verify an authorization credential file (the JSON the Sessions page exports) with the agent's own
// verifier: ecrecover for an EOA issuer, ERC-1271 isValidSignature on `rpcUrl` for a Base Account.
// usage: tsx examples/verify-vc-file.ts <vc.json> [rpcUrl]
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { verifyAuthorizationVCWithProvider } from "@pepelab/shared";

const [file, rpcUrl = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org"] = process.argv.slice(2);
if (!file) {
  console.error("usage: tsx examples/verify-vc-file.ts <vc.json> [rpcUrl]");
  process.exit(2);
}
const vc = JSON.parse(readFileSync(file, "utf8"));
const provider = new ethers.JsonRpcProvider(rpcUrl, 84532, { staticNetwork: true });
const res = await verifyAuthorizationVCWithProvider(vc, provider);
console.log(JSON.stringify(res));
process.exit(res.valid ? 0 : 1);
