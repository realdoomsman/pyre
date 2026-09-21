import { BaseError, ContractFunctionRevertedError, type Hash, type LocalAccount } from "viem";
import { publicClient, waitForSuccess, walletClient, type PyrePublicClient } from "../chain.js";
import { curveAbi, escrowAbi, hookAbi } from "./abi.js";
import { ponsAddresses } from "./addresses.js";
import type { LaunchRecord } from "./read.js";

export interface SweepResult {
  swept: boolean;
  hash?: Hash;
  /** Why nothing was swept: the revert name (`InternalSwapRequiresOperator`, …) or `nothing-to-sweep` / `phase-<n>`. */
  reason?: string;
}

export interface ClaimResult {
  hash?: Hash;
  wei: bigint;
}

/** Reverts that mean "not ours to sweep right now" rather than a bug — the PONS operator will sweep. */
const TOLERATED: Record<string, true> = {
  InternalSwapRequiresOperator: true,
  NotFeeSweepOperator: true,
  NotAuthorized: true,
  MinimumOutputRequired: true,
};

/** Name of a tolerated custom-error revert, else rethrows. */
function tolerate(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
    if (name && TOLERATED[name]) return name;
  }
  throw err;
}

async function sweepCurve(account: LocalAccount, launch: LaunchRecord, client: PyrePublicClient): Promise<SweepResult> {
  const curve = { address: launch.curve, abi: curveAbi } as const;
  const [fees, tax] = await Promise.all([
    client.readContract({ ...curve, functionName: "quoteFeeBalance" }),
    client.readContract({ ...curve, functionName: "creatorTaxBalance" }),
  ]);
  if (fees + tax === 0n) return { swept: false, reason: "nothing-to-sweep" };
  try {
    await client.simulateContract({ ...curve, functionName: "sweepFees", args: [0n], account });
  } catch (err) {
    return { swept: false, reason: tolerate(err) };
  }
  const hash = await walletClient(account).writeContract({ ...curve, functionName: "sweepFees", args: [0n] });
  await waitForSuccess(hash, client);
  return { swept: true, hash };
}

async function sweepPool(account: LocalAccount, launch: LaunchRecord, client: PyrePublicClient): Promise<SweepResult> {
  const hook = { address: ponsAddresses().memeHook, abi: hookAbi } as const;
  const [fees, tax] = await Promise.all([
    client.readContract({ ...hook, functionName: "pendingFees", args: [launch.poolId, launch.pairToken] }),
    client.readContract({ ...hook, functionName: "pendingCreatorTax", args: [launch.poolId, launch.pairToken] }),
  ]);
  if (fees + tax === 0n) return { swept: false, reason: "nothing-to-sweep" };
  try {
    await client.simulateContract({ ...hook, functionName: "sweepPoolFees", args: [launch.poolId, 0n, 0n], account });
  } catch (err) {
    return { swept: false, reason: tolerate(err) };
  }
  const hash = await walletClient(account).writeContract({ ...hook, functionName: "sweepPoolFees", args: [launch.poolId, 0n, 0n] });
  await waitForSuccess(hash, client);
  return { swept: true, hash };
}

/**
 * Moves accrued creator fees into the escrow: `curve.sweepFees(0)` before graduation,
 * `hook.sweepPoolFees(poolId, 0, 0)` after. Skips when nothing is pending, simulates first, and
 * reports reverts only the PONS operator can resolve (`InternalSwapRequiresOperator` etc.) as
 * `{swept:false, reason}` instead of throwing.
 */
export async function sweepCreatorFees(account: LocalAccount, launch: LaunchRecord): Promise<SweepResult> {
  const client = publicClient();
  if (launch.phase === 0) return sweepCurve(account, launch, client);
  if (launch.phase === 2) return sweepPool(account, launch, client);
  return { swept: false, reason: `phase-${launch.phase}` };
}

/** Pulls the caller's native escrow balance (`escrow.claim()`); `{wei: 0n}` without a tx when nothing is owed. */
export async function claimEscrow(account: LocalAccount): Promise<ClaimResult> {
  const client = publicClient();
  const { feeEscrow } = ponsAddresses();
  const wei = await client.readContract({ address: feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [account.address] });
  if (wei === 0n) return { wei: 0n };
  const hash = await walletClient(account).writeContract({ address: feeEscrow, abi: escrowAbi, functionName: "claim" });
  await waitForSuccess(hash, client);
  return { hash, wei };
}
