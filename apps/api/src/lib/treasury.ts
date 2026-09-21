import { treasury } from "@pyre/chain";

/** Platform treasury (custodial derivation index 0), derived once at boot. */
const TREASURY = treasury();
export const TREASURY_ACCOUNT = TREASURY.account;
export const TREASURY_WALLET = TREASURY.address;
