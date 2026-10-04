#!/usr/bin/env node
/**
 * Launch the Solana PYRE coin on pump.fun from the treasury Solana wallet (create_v2, no dev buy),
 * so the treasury is the coin's creator and collects its creator fees; 25% of them fund the PYRE
 * holder refund program (see docs/runbook.md "PYRE refund program"). Run once:
 *
 *   railway ssh --service runner -- node apps/runner/scripts/launch-pyre-sol.mjs --metadata-url https://pyre.fun/pyre-sol-metadata.json --confirm
 *
 * pump.fun stores only a metadata URI on chain and reads `name`, `symbol`, `description`, `image`
 * from the JSON behind it, exactly like app launches (whose JSON the API serves at
 * /v1/apps/:slug/metadata.json). PYRE is not an app, so the operator hosts that JSON at a
 * permanent public https URL first; `--print-metadata` prints the body to host. The script fetches
 * the URL and refuses unless it serves that name and symbol.
 *
 * Refuses when PYRE_SOL_MINT is already set, SOLANA_RPC_URL is unset, pump.fun is not accepting
 * launches, or the treasury Solana wallet holds less than twice the predicted cost.
 *
 * Alternative (no script): the founder launches the coin from his own wallet on pump.fun, then
 * turns on pump.fun creator fee sharing with the treasury Solana wallet as the only shareholder
 * at 100% and finalizes it. The runner's fee sweep sees the sharing config, runs the
 * permissionless distribute itself when fees are pending, and credits REFUND from every
 * distribution that paid the treasury, whoever sent it, so the treasury collects the same fees
 * either way (see docs/runbook.md "PYRE refund program", step 4 and "Distribution receipts").
 */
import { canPumpLaunch, getSolBalance, launchPumpCoin, predictPumpLaunchCost, pumpAdapter, solSigner } from "@pyre/chain";

const NAME = "Pyre";
const SYMBOL = "PYRE";
const IMAGE = "https://pyre.fun/icon-512.png";
const DESCRIPTION = "PYRE on Solana, launched by the Pyre treasury. A share of its creator fees refunds the ETH that holders of the Robinhood Chain PYRE put in.";
const METADATA = { name: NAME, symbol: SYMBOL, description: DESCRIPTION, image: IMAGE, showName: true, createdOn: "https://pyre.fun", website: "https://pyre.fun/refund", twitter: "https://x.com/PyreFun" };

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const sol = (lamports) => (Number(lamports) / 1e9).toFixed(4);

if (process.argv.includes("--print-metadata")) {
  console.log(JSON.stringify(METADATA, null, 2));
  process.exit(0);
}
if (process.env.PYRE_SOL_MINT) {
  console.error(`PYRE_SOL_MINT is already set (${process.env.PYRE_SOL_MINT}); refusing to launch a second coin.`);
  process.exit(2);
}
if (!process.env.SOLANA_RPC_URL) {
  console.error("SOLANA_RPC_URL is unset; refusing to launch.");
  process.exit(2);
}
const metadataUrl = arg("--metadata-url");
if (!metadataUrl || !metadataUrl.startsWith("https://")) {
  console.error("--metadata-url <https url> is required: host the JSON from --print-metadata there first.");
  process.exit(2);
}
const res = await fetch(metadataUrl).catch((err) => {
  console.error(`could not fetch ${metadataUrl}: ${err.message}`);
  process.exit(2);
});
const served = res.ok ? await res.json().catch(() => null) : null;
if (!served || served.name !== NAME || served.symbol !== SYMBOL || typeof served.image !== "string") {
  console.error(`${metadataUrl} must serve JSON with name "${NAME}", symbol "${SYMBOL}" and an image (got HTTP ${res.status}).`);
  process.exit(2);
}
if (!process.argv.includes("--confirm")) {
  console.error("this launches a real coin from the treasury Solana wallet. Re-run with --confirm.");
  process.exit(2);
}

const t = pumpAdapter.treasury();
const gate = await canPumpLaunch();
if (!gate.ok) {
  console.error(`pump.fun is not accepting launches: ${gate.reason ?? "unknown"}`);
  process.exit(3);
}
const [balance, cost] = await Promise.all([getSolBalance(t.address), predictPumpLaunchCost(t.address)]);
console.log(`treasury ${t.address}: ${sol(balance)} SOL · launch needs ≈ ${sol(cost)} SOL`);
if (balance < cost * 2n) {
  console.error("not enough SOL for the launch plus a reserve; fund the treasury Solana wallet first.");
  process.exit(3);
}
const r = await launchPumpCoin(solSigner(t), {
  name: NAME,
  symbol: SYMBOL,
  imageUrl: served.image,
  metadataUrl,
  description: DESCRIPTION,
  socials: { website: METADATA.website, twitter: METADATA.twitter },
});
console.log(JSON.stringify({ signature: r.hash, slot: r.block, mint: r.token, curve: r.curve, pump: pumpAdapter.info.launchpadUrl(r.token) }, null, 2));
console.log(
  `\nnext:\n  railway variables --service api --set PYRE_SOL_MINT=${r.token}\n  railway variables --service runner --set PYRE_SOL_MINT=${r.token}\n  railway up --service api --ci --detach && railway up --service runner --ci --detach`,
);
