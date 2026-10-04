import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateLaunchBody } from "@pyre/shared";

/**
 * Coins launch on pump.fun only. A launch with no launchpad lands on pump.fun, an explicit PONS v2
 * launch is refused before anything is written or queued, and a fork of a legacy Robinhood Chain
 * coin launches on pump.fun with a Solana app wallet rather than following its parent.
 */

const fx = vi.hoisted(() => ({
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-app", keypairIndex: 9, ...data })),
  update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-app", keypairIndex: 9, chain: "solana", launchpad: "pump_fun", ...data })),
  intakeAdd: vi.fn(async () => undefined),
  solanaEnabled: true,
}));

vi.mock("@pyre/db", () => ({
  prisma: {
    app: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ app: { create: fx.create, update: fx.update } }),
  },
  Prisma: { PrismaClientKnownRequestError: class {} },
}));
vi.mock("@pyre/chain", () => ({
  adapterFor: (launchpad: string) => ({ appWallet: (index: number) => ({ address: `${launchpad}-app-wallet-${index}` }) }),
  solanaEnabled: () => fx.solanaEnabled,
  deriveWallet: () => ({ address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", account: { address: "0x84F8E5a324466Deb7447048C014CF0245ce04afA" } }),
  getEthBalance: vi.fn(),
  getErc20Balance: vi.fn(),
  usdgAddress: () => "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: { address: "0x0000000000000000000000000000000000000001" } }),
}));
vi.mock("../src/lib/events.js", () => ({ publishEvent: vi.fn() }));
vi.mock("../src/lib/queues.js", () => ({ queues: { intake: { add: fx.intakeAdd } } }));

import type { App, User } from "@pyre/db";
import { createLaunch } from "../src/lib/launch.js";

const USER = { id: "u1", wallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", reputation: 0, isAdmin: false } as unknown as User;
const body = (over: Record<string, unknown> = {}) =>
  CreateLaunchBody.parse({ name: "Inbox Zero", ticker: "INBOX", imageUrl: "https://example.com/logo.png", prompt: "A tool that triages your inbox down to zero.", ...over });
const PONS_PARENT = { id: "parent", name: "Pyre Cat", ticker: "PYRECAT", prompt: "a cat app for the pyre faithful", spec: null, repoUrl: null, chain: "robinhood", launchpad: "pons_v2", status: "LIVE" } as unknown as App;

beforeEach(() => {
  vi.clearAllMocks();
  fx.solanaEnabled = true;
});

describe("createLaunch venue", () => {
  it("launches on pump.fun when no launchpad is given", async () => {
    const app = await createLaunch(USER, body(), null);
    expect(fx.create).toHaveBeenCalledWith({ data: expect.objectContaining({ chain: "solana", launchpad: "pump_fun", forkOfId: null }) });
    expect(app.walletAddress).toBe("pump_fun-app-wallet-9");
    expect(fx.intakeAdd).toHaveBeenCalledTimes(1);
  });

  it("refuses an explicit PONS v2 launch with venue_disabled before writing or queueing anything", async () => {
    await expect(createLaunch(USER, body({ launchpad: "pons_v2" }), null)).rejects.toMatchObject({ status: 409, message: "venue_disabled", extra: { launchpad: "pons_v2" } });
    expect(fx.create).not.toHaveBeenCalled();
    expect(fx.intakeAdd).not.toHaveBeenCalled();
  });

  it("launches a fork of a legacy Robinhood Chain coin on pump.fun, whatever launchpad the body names", async () => {
    await createLaunch(USER, body({ launchpad: "pons_v2", forkOfAppId: PONS_PARENT.id }), PONS_PARENT);
    expect(fx.create).toHaveBeenCalledWith({ data: expect.objectContaining({ chain: "solana", launchpad: "pump_fun", forkOfId: "parent" }) });
    expect(fx.update).toHaveBeenCalledWith({ where: { id: "new-app" }, data: { walletAddress: "pump_fun-app-wallet-9" } });
  });

  it("refuses a fork while pump.fun is not accepting launches instead of falling back to the parent's venue", async () => {
    fx.solanaEnabled = false;
    await expect(createLaunch(USER, body({ forkOfAppId: PONS_PARENT.id }), PONS_PARENT)).rejects.toMatchObject({ status: 409, message: "venue_disabled", extra: { launchpad: "pump_fun" } });
    expect(fx.create).not.toHaveBeenCalled();
  });
});
