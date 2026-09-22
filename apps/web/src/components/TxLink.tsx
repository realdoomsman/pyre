import { Address, type AddressProps } from "../ui/index.js";
import { ROBINHOOD, type VenueLinks } from "../lib/venue.js";

type LinkProps = Omit<AddressProps, "address" | "kind" | "explorerUrl"> & {
  /** The venue whose explorer resolves the hash; Robinhood Chain (Blockscout) when omitted. */
  venue?: VenueLinks;
};

/** A transaction hash → `0x1234…abcd` / `5Kd3…9xQm` linking to the venue's explorer. */
export const TxLink = ({ hash, venue = ROBINHOOD, ...rest }: LinkProps & { hash: string }) => (
  <Address address={hash} kind="tx" explorerUrl={venue.tx(hash)} identicon={false} {...rest} />
);

/** An account address → identicon + short form linking to the venue's explorer. */
export const AddressLink = ({ address, venue = ROBINHOOD, ...rest }: LinkProps & { address: string }) => (
  <Address address={address} kind="address" explorerUrl={venue.address(address)} {...rest} />
);
