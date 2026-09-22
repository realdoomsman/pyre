import { beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_STAKE_BY_CHAIN, LAUNCH_STAKE_WEI, VenuesDto } from "@pyre/shared";

/**
 * `GET /v1/venues` is what the web's launch picker reads: a venue must be reported enabled only
 * when the API can actually serve it (Solana RPC configured and pump launches not switched off),
 * and the stake must be the one `settleStake` will demand on that chain, env overrides included.
 */

const fx = vi.hoisted(() => ({
  solanaEnabled: true,
  env: { PUMP_LAUNCH_ENABLED: true as boolean, SOLANA_CLUSTER: "devnet" as "devnet" | "mainnet-beta", LAUNCH_STAKE_LAMPORTS: undefined as bigint | undefined },
}));

vi.mock("@pyre/chain", () => ({
  solanaEnabled: () => fx.solanaEnabled,
  adapterFor: () => {
    throw new Error("not needed");
  },
}));
vi.mock("../src/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, p) => (p === "PUMP_LAUNCH_ENABLED" ? fx.env.PUMP_LAUNCH_ENABLED : p === "SOLANA_CLUSTER" ? fx.env.SOLANA_CLUSTER : p === "LAUNCH_STAKE_LAMPORTS" ? (fx.env.LAUNCH_STAKE_LAMPORTS ?? t[p as string]) : t[p as string]),
    }),
  };
});

import { assertVenueEnabled, venuesDto } from "../src/lib/venue.js";

beforeEach(() => {
  fx.solanaEnabled = true;
  fx.env.PUMP_LAUNCH_ENABLED = true;
  fx.env.SOLANA_CLUSTER = "devnet";
  fx.env.LAUNCH_STAKE_LAMPORTS = undefined;
});

describe("/v1/venues", () => {
  it("lists both venues with their stake, native asset and cluster when Solana is configured", () => {
    const body = { venues: venuesDto() };
    expect(VenuesDto.parse(body)).toEqual(body);
    expect(body.venues).toEqual([
      expect.objectContaining({ chain: "robinhood", launchpad: "pons_v2", enabled: true, stakeWei: LAUNCH_STAKE_WEI.toString(), native: { symbol: "ETH", decimals: 18 }, tokenDecimals: 18, cluster: null }),
      expect.objectContaining({ chain: "solana", launchpad: "pump_fun", enabled: true, stakeWei: LAUNCH_STAKE_BY_CHAIN.solana.toString(), native: { symbol: "SOL", decimals: 9 }, tokenDecimals: 6, cluster: "devnet" }),
    ]);
  });

  it("reports pump.fun disabled when SOLANA_RPC_URL is unset or PUMP_LAUNCH_ENABLED is off, and PONS stays enabled", () => {
    fx.solanaEnabled = false;
    expect(venuesDto().map((v) => v.enabled)).toEqual([true, false]);
    fx.solanaEnabled = true;
    fx.env.PUMP_LAUNCH_ENABLED = false;
    expect(venuesDto().map((v) => v.enabled)).toEqual([true, false]);
    expect(() => assertVenueEnabled("pump_fun")).toThrow(expect.objectContaining({ status: 409, message: "venue_disabled" }));
    expect(() => assertVenueEnabled("pons_v2")).not.toThrow();
  });

  it("honours a staging stake override for Solana", () => {
    fx.env.LAUNCH_STAKE_LAMPORTS = 50_000_000n;
    expect(venuesDto()[1]?.stakeWei).toBe("50000000");
  });
});
