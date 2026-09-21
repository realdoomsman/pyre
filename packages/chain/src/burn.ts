import { createHash } from "node:crypto";
import { getAddress, type Address, type Hash, type Hex, type LocalAccount } from "viem";
import { encodeAttestation } from "./browser.js";
import { waitForSuccess, walletClient } from "./chain.js";
import { tokenAbi } from "./pons/abi.js";

export { ATTESTATION_PREFIX, encodeAttestation, parseAttestation } from "./browser.js";

/** `sha256` over the sorted, comma-joined revenue event ids, 0x-prefixed. */
export const attestationHash = (revenueEventIds: string[]): Hex =>
  `0x${createHash("sha256").update([...revenueEventIds].sort().join(",")).digest("hex")}`;

/** ERC20Burnable `burn(units)` from the account's own balance; reduces `totalSupply`. */
export async function burnTokens(account: LocalAccount, token: Address, units: bigint): Promise<Hash> {
  if (units <= 0n) throw new Error("burnTokens: units must be positive");
  const hash = await walletClient(account).writeContract({ address: getAddress(token), abi: tokenAbi, functionName: "burn", args: [units] });
  await waitForSuccess(hash);
  return hash;
}

/** Zero-value self-transaction carrying the attestation calldata. */
export async function attestBurn(account: LocalAccount, hash32: Hex): Promise<Hash> {
  const hash = await walletClient(account).sendTransaction({ to: account.address, value: 0n, data: encodeAttestation(hash32) });
  await waitForSuccess(hash);
  return hash;
}
