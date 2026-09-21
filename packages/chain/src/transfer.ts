import { getAddress, parseEventLogs, parseSignature, toHex, type Address, type Hash, type Hex, type LocalAccount, type TypedDataDomain } from "viem";
import { USDG_EIP712_TYPES, usdgDomain as usdgDomainFor, type UsdgAuthorizationMessage, type UsdgAuthorizationTypedData } from "./browser.js";
import { publicClient, waitForSuccess, walletClient, type PyrePublicClient } from "./chain.js";
import { envOr } from "./env.js";
import { treasury } from "./keys.js";
import { erc20Abi, usdgAbi } from "./pons/abi.js";

export { USDG_DECIMALS, USDG_EIP712_TYPES, type UsdgAuthorizationMessage, type UsdgAuthorizationTypedData } from "./browser.js";

export const usdgAddress = (): Address => getAddress(envOr("USDG_ADDRESS"));

export async function getEthBalance(address: Address, client: PyrePublicClient = publicClient()): Promise<bigint> {
  return client.getBalance({ address: getAddress(address) });
}

export async function getErc20Balance(token: Address, address: Address, client: PyrePublicClient = publicClient()): Promise<bigint> {
  return client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [getAddress(address)] });
}

/** Sends `wei` from a custodial account. Resolves once mined and successful. */
export async function transferEth(from: LocalAccount, to: Address, wei: bigint): Promise<Hash> {
  if (wei <= 0n) throw new Error("transferEth: wei must be positive");
  const hash = await walletClient(from).sendTransaction({ to: getAddress(to), value: wei });
  await waitForSuccess(hash);
  return hash;
}

/** ERC-20 `transfer(to, units)` from a custodial account. Resolves once mined and successful. */
export async function transferErc20(from: LocalAccount, token: Address, to: Address, units: bigint): Promise<Hash> {
  if (units <= 0n) throw new Error("transferErc20: units must be positive");
  const hash = await walletClient(from).writeContract({ address: getAddress(token), abi: erc20Abi, functionName: "transfer", args: [getAddress(to), units] });
  await waitForSuccess(hash);
  return hash;
}

export interface EthTransferCheck {
  ok: boolean;
  from: Address;
  wei: bigint;
  /** Set when `ok` is false. */
  reason?: string;
}

export interface Erc20TransferCheck {
  ok: boolean;
  from: Address;
  units: bigint;
  reason?: string;
}

/**
 * Verifies a plain value transfer: mined with success, ≥1 confirmation, `tx.to === to`,
 * `tx.value ≥ minWei`, and `tx.from === from` when given. Internal (contract-originated)
 * transfers are not recognised; the treasury and custodial wallets are EOAs.
 */
export async function verifyEthTransfer(
  hash: Hash,
  opts: { to: Address; minWei: bigint; from?: Address },
  client: PyrePublicClient = publicClient(),
): Promise<EthTransferCheck> {
  const [tx, receipt, latest] = await Promise.all([
    client.getTransaction({ hash }).catch(() => undefined),
    client.getTransactionReceipt({ hash }).catch(() => undefined),
    client.getBlockNumber(),
  ]);
  if (!tx || !receipt) return { ok: false, from: "0x0000000000000000000000000000000000000000", wei: 0n, reason: "not-found" };
  const from = getAddress(tx.from);
  const wei = tx.value;
  if (receipt.status !== "success") return { ok: false, from, wei, reason: "reverted" };
  if (latest - receipt.blockNumber + 1n < 1n) return { ok: false, from, wei, reason: "unconfirmed" };
  if (!tx.to || tx.to.toLowerCase() !== opts.to.toLowerCase()) return { ok: false, from, wei, reason: "wrong-recipient" };
  if (opts.from && from.toLowerCase() !== opts.from.toLowerCase()) return { ok: false, from, wei, reason: "wrong-sender" };
  if (wei < opts.minWei) return { ok: false, from, wei, reason: "insufficient" };
  return { ok: true, from, wei };
}

/**
 * Verifies an ERC-20 transfer by its `Transfer` logs: mined with success, ≥1 confirmation, and
 * the sum of `token` transfers to `to` ≥ `minUnits`. `from` is the payer on the first matching
 * log (for relayed EIP-3009 transfers this is the authorizer, not the relaying treasury).
 */
export async function verifyErc20Transfer(
  hash: Hash,
  opts: { token: Address; to: Address; minUnits: bigint },
  client: PyrePublicClient = publicClient(),
): Promise<Erc20TransferCheck> {
  const [receipt, latest] = await Promise.all([client.getTransactionReceipt({ hash }).catch(() => undefined), client.getBlockNumber()]);
  const zero: Address = "0x0000000000000000000000000000000000000000";
  if (!receipt) return { ok: false, from: zero, units: 0n, reason: "not-found" };
  if (receipt.status !== "success") return { ok: false, from: getAddress(receipt.from), units: 0n, reason: "reverted" };
  if (latest - receipt.blockNumber + 1n < 1n) return { ok: false, from: getAddress(receipt.from), units: 0n, reason: "unconfirmed" };
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs, args: { to: getAddress(opts.to) } }).filter(
    (log) => log.address.toLowerCase() === opts.token.toLowerCase(),
  );
  const first = transfers[0];
  if (!first) return { ok: false, from: getAddress(receipt.from), units: 0n, reason: "no-transfer" };
  const units = transfers.reduce((sum, log) => sum + log.args.value, 0n);
  const from = getAddress(first.args.from);
  if (units < opts.minUnits) return { ok: false, from, units, reason: "insufficient" };
  return { ok: true, from, units };
}

/* ---------------------------------- EIP-3009 (USDG) ---------------------------------- */

export interface Eip3009Auth {
  from: Address;
  to: Address;
  /** USDG units (1e6). */
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
}

/** EIP-712 domain of USDG on Robinhood Chain; matches the on-chain `DOMAIN_SEPARATOR()`. */
export function usdgDomain(): TypedDataDomain {
  return usdgDomainFor(usdgAddress());
}

/** Typed-data payload for `TransferWithAuthorization` — what a browser wallet signs via `eth_signTypedData_v4`. */
export function usdgAuthorizationTypedData(message: UsdgAuthorizationMessage): UsdgAuthorizationTypedData {
  return { domain: usdgDomain(), types: USDG_EIP712_TYPES, primaryType: "TransferWithAuthorization", message };
}

/**
 * Signs an EIP-3009 `TransferWithAuthorization` for USDG from a custodial account. The signer pays
 * nothing; the treasury relays it with `relayUsdgAuthorization`.
 */
export async function signUsdgAuthorization(
  account: LocalAccount,
  opts: { to: Address; units: bigint; validBefore: bigint; validAfter?: bigint; nonce?: Hex },
): Promise<Eip3009Auth> {
  if (opts.units <= 0n) throw new Error("signUsdgAuthorization: units must be positive");
  const message: UsdgAuthorizationMessage = {
    from: account.address,
    to: getAddress(opts.to),
    value: opts.units,
    validAfter: opts.validAfter ?? 0n,
    validBefore: opts.validBefore,
    nonce: opts.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData(usdgAuthorizationTypedData(message));
  const { v, r, s, yParity } = parseSignature(signature);
  return { ...message, v: v !== undefined ? Number(v) : 27 + (yParity ?? 0), r, s };
}

/** Treasury submits `transferWithAuthorization(...)` and pays the gas. Resolves once mined and successful. */
export async function relayUsdgAuthorization(auth: Eip3009Auth): Promise<Hash> {
  const hash = await walletClient(treasury().account).writeContract({
    address: usdgAddress(),
    abi: usdgAbi,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s],
  });
  await waitForSuccess(hash);
  return hash;
}
