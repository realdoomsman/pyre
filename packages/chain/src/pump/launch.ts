import { GLOBAL_PDA, PUMP_SDK, bondingCurvePda, type Global } from "@pump-fun/pump-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { optionalEnv } from "../env.js";
import { SOLANA_COMMITMENT, connection } from "../solana/connection.js";
import { COMPUTE_UNITS, computeUnitPrice, priorityFeeLamports } from "../solana/fees.js";
import { pubkey, solTreasury } from "../solana/keys.js";
import { sendInstructions, simulateInstructions } from "../solana/send.js";
import type { VenueLaunchParams } from "../venue.js";

/** On-chain caps of `create_v2` (bytes). */
const CAPS = { name: 32, symbol: 13, uri: 200 } as const;
const utf8 = new TextEncoder();

function checkLength(field: keyof typeof CAPS, value: string): void {
  if (utf8.encode(value).length > CAPS[field]) throw new Error(`pump launch ${field} exceeds ${CAPS[field]} bytes`);
}

export class PumpLaunchDisabledError extends Error {
  constructor(readonly reason: string) {
    super(`pump launches unavailable: ${reason}`);
    this.name = "PumpLaunchDisabledError";
  }
}

export async function readPumpGlobal(): Promise<Global> {
  const info = await connection().getAccountInfo(GLOBAL_PDA, SOLANA_COMMITMENT);
  if (!info) throw new Error("pump Global account not found: wrong cluster?");
  return PUMP_SDK.decodeGlobal(info);
}

/** Pure gate over the Global kill switches and the `PUMP_LAUNCH_ENABLED` env. Exported for tests. */
export function launchGate(global: Pick<Global, "initialized" | "createV2Enabled">, envEnabled: string | undefined): { ok: boolean; reason?: string } {
  if (envEnabled !== undefined && !/^(1|true|yes)$/i.test(envEnabled)) return { ok: false, reason: "PUMP_LAUNCH_ENABLED is off" };
  if (!global.initialized) return { ok: false, reason: "pump Global is not initialised" };
  if (!global.createV2Enabled) return { ok: false, reason: "pump create_v2 is disabled" };
  return { ok: true };
}

/** Whether pump currently accepts `create_v2` from anyone (there is no per-wallet gating on pump). */
export async function canPumpLaunch(): Promise<{ ok: boolean; reason?: string }> {
  return launchGate(await readPumpGlobal(), optionalEnv("PUMP_LAUNCH_ENABLED"));
}

export interface PumpLaunchResult {
  hash: string;
  block: number;
  token: string;
  curve: string;
}

/**
 * `create_v2` with a fresh mint, no initial buy, `creator = user = the app wallet` (it signs, pays
 * the rent, and receives creator fees in its vault). Metadata is the Pyre-hosted JSON URL.
 */
export async function launchPumpCoin(user: Keypair, params: VenueLaunchParams): Promise<PumpLaunchResult> {
  checkLength("name", params.name);
  checkLength("symbol", params.symbol);
  checkLength("uri", params.metadataUrl);
  const gate = launchGate(await readPumpGlobal(), optionalEnv("PUMP_LAUNCH_ENABLED"));
  if (!gate.ok) throw new PumpLaunchDisabledError(gate.reason ?? "unknown");
  const mint = Keypair.generate();
  const ix = await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name: params.name, symbol: params.symbol, uri: params.metadataUrl, creator: user.publicKey, user: user.publicKey, mayhemMode: false });
  const res = await sendInstructions(user, [ix], { computeUnits: COMPUTE_UNITS.create, signers: [mint] });
  return { hash: res.signature, block: res.slot, token: mint.publicKey.toBase58(), curve: bondingCurvePda(mint.publicKey).toBase58() };
}

/** Below this the wallet cannot even pay the simulated rent, so the treasury stands in as payer. */
const MIN_SIMULATION_BALANCE = 10_000_000n;

/**
 * Lamports the launching wallet must hold: rent for the mint, curve, curve ATA and mayhem state
 * plus fees, measured by simulating `create_v2`, times 1.5 for priority-fee variance (like the
 * PONS gas margin). An unfunded app wallet is simulated with the treasury as payer — pump does not
 * care who pays, only who `creator` is.
 */
export async function predictPumpLaunchCost(from: string): Promise<bigint> {
  const conn = connection();
  const creator = pubkey(from);
  const fromBalance = BigInt(await conn.getBalance(creator, SOLANA_COMMITMENT));
  const payer: PublicKey = fromBalance >= MIN_SIMULATION_BALANCE ? creator : solTreasury().keypair.publicKey;
  const mint = Keypair.generate();
  const ix = await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name: "Pyre launch", symbol: "PYRE", uri: "https://pyre.fun/metadata.json", creator, user: payer, mayhemMode: false });
  const microLamports = await computeUnitPrice(conn, [mint.publicKey, payer]);
  const before = payer.equals(creator) ? fromBalance : BigInt(await conn.getBalance(payer, SOLANA_COMMITMENT));
  const sim = await simulateInstructions(payer, [ix], COMPUTE_UNITS.create, microLamports);
  if (sim.err) throw new Error(`pump create_v2 simulation failed from ${payer.toBase58()}: ${JSON.stringify(sim.err)}\n${sim.logs.slice(-6).join("\n")}`);
  const spent = sim.payerLamportsAfter === null ? 0n : before - sim.payerLamportsAfter;
  const cost = (spent > 0n ? spent : 0n) + priorityFeeLamports(COMPUTE_UNITS.create, microLamports, 2);
  return (cost * 3n) / 2n;
}
