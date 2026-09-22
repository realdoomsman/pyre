#!/usr/bin/env node
/**
 * Launch $PYRE on PONS v2 from the treasury. Run once, after the treasury holds ETH:
 *
 *   railway ssh --service runner -- node apps/runner/scripts/launch-pyre.mjs --i-am-launching-pyre
 *
 * Prints the token + curve addresses and the exact env changes to apply. Refuses to run if
 * PYRE_TOKEN is already set, if the treasury cannot cover fee + gas, or if PONS gates launches.
 */
import { formatEther } from "viem";
import { getEthBalance, launchPonsToken, predictLaunchCost, ponsUrl, treasury } from "@pyre/chain";

if (process.env.PYRE_TOKEN) {
  console.error(`PYRE_TOKEN is already set (${process.env.PYRE_TOKEN}); refusing to launch a second coin.`);
  process.exit(2);
}
if (!process.argv.includes("--i-am-launching-pyre")) {
  console.error("this launches a real coin from the treasury. Re-run with --i-am-launching-pyre to confirm.");
  process.exit(2);
}
const t = treasury();
const [balance, cost] = await Promise.all([getEthBalance(t.address), predictLaunchCost(t.address)]);
console.log(`treasury ${t.address}: ${formatEther(balance)} ETH · launch needs ≈ ${formatEther(cost.totalWei)} ETH (fee ${formatEther(cost.launchFeeWei)} + gas)`);
if (balance < cost.totalWei * 2n) {
  console.error("not enough ETH for the launch plus a gas reserve; fund the treasury first.");
  process.exit(3);
}
const r = await launchPonsToken(t.account, {
  name: "Pyre",
  symbol: "PYRE",
  logo: "https://pyre.fun/icon-512.png",
  description: "the coin that funds every app on pyre.fun and burns with a share of every coin's fees",
  socials: { website: "https://pyre.fun", twitter: "https://x.com/PyreFun" },
  creatorFeeRecipient: t.address,
});
console.log(JSON.stringify({ hash: r.hash, token: r.token, curve: r.curve, pons: ponsUrl(r.token) }, null, 2));
console.log(`\nnext:\n  railway variables --service api --set PYRE_TOKEN=${r.token}\n  railway variables --service runner --set PYRE_TOKEN=${r.token}\n  railway variables --service web --set VITE_PYRE_TOKEN=${r.token}\n  railway up --service api --ci --detach && railway up --service runner --ci --detach && railway up --service web --ci --detach`);
