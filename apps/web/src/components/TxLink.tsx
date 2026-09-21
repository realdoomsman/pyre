import { Address, type AddressProps } from "../ui/index.js";
import { explorerAddress, explorerTx } from "../env.js";

type LinkProps = Omit<AddressProps, "address" | "kind" | "explorerUrl">;

/** A transaction hash → `0x1234…abcd` linking to Blockscout. */
export const TxLink = ({ hash, ...rest }: LinkProps & { hash: string }) => (
  <Address address={hash} kind="tx" explorerUrl={explorerTx(hash)} identicon={false} {...rest} />
);

/** An account address → identicon + short form linking to Blockscout. */
export const AddressLink = ({ address, ...rest }: LinkProps & { address: string }) => (
  <Address address={address} kind="address" explorerUrl={explorerAddress(address)} {...rest} />
);
