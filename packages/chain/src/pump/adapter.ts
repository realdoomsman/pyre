import type { Keypair } from "@solana/web3.js";
import { solanaCluster } from "../solana/connection.js";
import { deriveSolAppWallet, deriveSolWallet, isSolAddress, isSolSignature, solTreasury, type SolWallet } from "../solana/keys.js";
import { attestOnSolana, readAttestationOnSolana } from "../solana/memo.js";
import { getSolBalance, transferSol, verifySolTransfer } from "../solana/native.js";
import { getSolPriceUsd } from "../solana/price.js";
import type { VenueAccount, VenueAdapter, VenueInfo } from "../venue.js";
import { accruingPumpFees, claimPumpFees } from "./feesClaim.js";
import { pumpHolders } from "./holders.js";
import { canPumpLaunch, launchPumpCoin, predictPumpLaunchCost } from "./launch.js";
import { PUMP_TOKEN_DECIMALS, PUMP_TOTAL_SUPPLY_UNITS, readPumpLaunch } from "./read.js";
import { pumpBuy, pumpQuoteBuy, pumpQuoteSell, pumpSell } from "./swap.js";
import { burnPumpToken, pumpTokenBalance, transferPumpToken } from "./token.js";
import { currentSlot, pumpTrades } from "./trades.js";

/** Solscan, with `?cluster=devnet` on devnet; pump.fun coin pages are mainnet only. */
const solscan = (path: string): string => `https://solscan.io/${path}${solanaCluster() === "devnet" ? "?cluster=devnet" : ""}`;

export const PUMP_INFO: VenueInfo = {
  chain: "solana",
  launchpad: "pump_fun",
  native: { symbol: "SOL", decimals: 9 },
  tokenDecimals: PUMP_TOKEN_DECIMALS,
  totalSupplyUnits: PUMP_TOTAL_SUPPLY_UNITS,
  chainLabel: "Solana",
  launchpadLabel: "pump.fun",
  explorerTxUrl: (tx) => solscan(`tx/${tx}`),
  explorerAddressUrl: (address) => solscan(`account/${address}`),
  explorerTokenUrl: (token) => solscan(`token/${token}`),
  launchpadUrl: (token) => `https://pump.fun/coin/${token}`,
};

const account = (w: SolWallet): VenueAccount => ({ chain: "solana", address: w.address, signer: w.keypair });

/** The web3.js `Keypair` behind a Solana `VenueAccount`. */
export function solSigner(acct: VenueAccount): Keypair {
  if (acct.chain !== "solana") throw new Error(`expected a solana account, got ${acct.chain}`);
  return acct.signer as Keypair;
}

export const pumpAdapter: VenueAdapter = {
  info: PUMP_INFO,

  treasury: () => account(solTreasury()),
  userWallet: (walletIndex) => account(deriveSolWallet(walletIndex)),
  appWallet: (keypairIndex) => account(deriveSolAppWallet(keypairIndex)),
  isAddress: isSolAddress,
  isTxHash: isSolSignature,

  nativeBalance: getSolBalance,
  transferNative: async (from, to, amount) => {
    const res = await transferSol(solSigner(from), to, amount);
    return { hash: res.signature, block: res.slot };
  },
  verifyNativeTransfer: async (hash, to, minAmount, from) => {
    const check = await verifySolTransfer(hash, { to, minLamports: minAmount, from });
    return { ok: check.ok, from: check.from, amount: check.lamports, reason: check.reason };
  },
  nativePriceUsd: getSolPriceUsd,

  predictLaunchCost: predictPumpLaunchCost,
  canLaunch: () => canPumpLaunch(),
  launch: (from, params) => launchPumpCoin(solSigner(from), params),
  readLaunch: readPumpLaunch,

  accruingFees: (_token, creator) => accruingPumpFees(creator),
  sweepFees: async () => ({ swept: false, reason: "not-needed" }),
  claimFees: (acct) => claimPumpFees(solSigner(acct)),

  quoteBuy: pumpQuoteBuy,
  quoteSell: pumpQuoteSell,
  buy: (acct, token, spend, minTokens) => pumpBuy(solSigner(acct), token, spend, minTokens),
  sell: (acct, token, units, minNative) => pumpSell(solSigner(acct), token, units, minNative),
  tokenBalance: pumpTokenBalance,
  transferToken: async (from, token, to, units) => {
    const res = await transferPumpToken(solSigner(from), token, to, units);
    return { hash: res.signature, block: res.slot };
  },

  burn: async (acct, token, units) => {
    const res = await burnPumpToken(solSigner(acct), token, units);
    return { hash: res.signature, block: res.slot, burnedUnits: res.burnedUnits };
  },
  attest: async (acct, digestHex) => {
    const res = await attestOnSolana(solSigner(acct), digestHex);
    return { hash: res.signature, block: res.slot };
  },
  readAttestation: readAttestationOnSolana,

  currentBlock: currentSlot,
  trades: pumpTrades,
  holders: pumpHolders,
};
