import { getAddress, type Address } from "viem";
import { PONS_ADDRESSES, type PonsAddresses } from "../browser.js";
import { optionalEnv } from "../env.js";

export { DEAD_ADDRESS, PONS_ADDRESSES, type PonsAddresses } from "../browser.js";

/**
 * PONS v2 + Uniswap v4 addresses on Robinhood Chain (chain id 4663). The defaults live in
 * `browser.ts` (shared with the web bundle); every value is overridable by env so a redeployed
 * launchpad can be pinned without a code change.
 */
const ENV_KEYS = {
  factory: "PONS_FACTORY",
  launchAndBuy: "PONS_LAUNCH_AND_BUY",
  feeEscrow: "PONS_FEE_ESCROW",
  memeHook: "PONS_MEME_HOOK",
  buybackVault: "PONS_BUYBACK_VAULT",
  locker: "PONS_LOCKER",
  deployer: "PONS_DEPLOYER",
  poolManager: "UNIV4_POOL_MANAGER",
  universalRouter: "UNIV4_UNIVERSAL_ROUTER",
  quoter: "UNIV4_QUOTER",
  stateView: "UNIV4_STATE_VIEW",
  permit2: "PERMIT2",
} as const satisfies Record<keyof PonsAddresses, string>;

export type PonsAddressKey = (typeof ENV_KEYS)[keyof typeof ENV_KEYS];

/** Current address set, honouring env overrides (read on each call; cost is negligible next to an RPC round trip). */
export function ponsAddresses(): PonsAddresses {
  const out = {} as Record<keyof PonsAddresses, Address>;
  for (const key of Object.keys(ENV_KEYS) as Array<keyof PonsAddresses>) {
    const override = optionalEnv(ENV_KEYS[key]);
    out[key] = override ? getAddress(override) : PONS_ADDRESSES[key];
  }
  return out;
}
