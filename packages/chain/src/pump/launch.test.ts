import { describe, expect, it } from "vitest";
import { launchGate } from "./launch.js";

describe("pump launch gate", () => {
  const open = { initialized: true, createV2Enabled: true };

  it("is open when pump's create_v2 switch is on and the env does not disable launches", () => {
    expect(launchGate(open, undefined)).toEqual({ ok: true });
    expect(launchGate(open, "true")).toEqual({ ok: true });
    expect(launchGate(open, "1")).toEqual({ ok: true });
  });

  it("closes on the env flag before consulting chain state, then on each kill switch", () => {
    expect(launchGate(open, "false")).toMatchObject({ ok: false, reason: expect.stringContaining("PUMP_LAUNCH_ENABLED") });
    expect(launchGate(open, "0")).toMatchObject({ ok: false });
    expect(launchGate({ ...open, createV2Enabled: false }, undefined)).toMatchObject({ ok: false, reason: expect.stringContaining("create_v2") });
    expect(launchGate({ ...open, initialized: false }, undefined)).toMatchObject({ ok: false, reason: expect.stringContaining("initialised") });
  });
});
