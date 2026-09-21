import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dec } from "@pyre/db";

/**
 * The two $PYRE platform-governance gates real holders hit:
 *  - submit: only wallets holding ≥3% of supply may open a platform-improvement proposal. The gate
 *    compares the caller's live capped weight against PLATFORM_PROPOSAL_MIN_HOLD, so a regression
 *    that softens (or hardens) the threshold lets the wrong wallets file — or locks everyone out.
 *  - vote: any positive holder may cast a capped, token-weighted vote; a zero-weight wallet must be
 *    turned away before a row is written.
 * The weight calculation itself (votes.js → chain read) is stubbed to a controllable value so this
 * stays pure decision-logic with no I/O; env.PYRE_TOKEN is proxied to exercise the launch gate.
 */

const fx = vi.hoisted(() => {
  const state = { holdWeight: 0n, pyreToken: "0x1111111111111111111111111111111111111111" as string | undefined };
  return {
    state,
    platformHoldWeight: vi.fn(async () => state.holdWeight),
    proposalCreate: vi.fn(async ({ data }: { data: { authorId: string; title: string; body: string } }) => ({
      id: "prop_1",
      title: data.title,
      body: data.body,
      status: "OPEN",
      ownerNote: null,
      authorId: data.authorId,
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
      updatedAt: new Date("2026-09-20T00:00:00.000Z"),
      author: { id: data.authorId, displayName: null, avatarUrl: null, wallet: null, xHandle: null },
    })),
    proposalFindUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
    proposalVoteUpsert: vi.fn(async () => ({})),
    getErc20Balance: vi.fn(async () => 0n),
  };
});

vi.mock("@pyre/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prisma: {
    proposal: { create: fx.proposalCreate, findUnique: fx.proposalFindUnique },
    proposalVote: { upsert: fx.proposalVoteUpsert },
  },
}));
vi.mock("@pyre/chain", () => ({
  getErc20Balance: fx.getErc20Balance,
  DEAD_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  ponsAddresses: () => ({ poolManager: "0x1", locker: "0x2", buybackVault: "0x3" }),
  treasury: () => ({ address: "0x0000000000000000000000000000000000000001", account: {} }),
}));
vi.mock("../src/lib/cache.js", () => ({ cached: <T,>(_k: unknown, _ttl: unknown, fn: () => Promise<T>) => fn() }));
vi.mock("../src/lib/metrics.js", () => ({ db: {} }));
// votes.js is where the gate math lives; stub the live weight but keep the real 3% floor value.
vi.mock("../src/lib/votes.js", () => ({
  platformHoldWeight: fx.platformHoldWeight,
  PLATFORM_PROPOSAL_MIN_HOLD: 30_000_000_000_000n,
  PLATFORM_PROPOSAL_QUORUM: 100_000_000_000_000n,
  SUPPLY_BASE_UNITS: 10n ** 27n,
}));
vi.mock("../src/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, p) => (p === "PYRE_TOKEN" ? fx.state.pyreToken : t[p as string]),
    }),
  };
});

import { submitProposalHandler, voteProposalHandler } from "../src/routes/proposals.js";

interface TestUser {
  id: string;
  wallet: string | null;
  walletIndex: number;
  reputation: number;
}
const USER: TestUser = { id: "u1", wallet: "0x84F8E5a324466Deb7447048C014CF0245ce04afA", walletIndex: 5, reputation: 0 };
const req = (opts: { body?: unknown; params?: Record<string, string>; user?: TestUser } = {}): Request =>
  ({ body: opts.body ?? {}, params: opts.params ?? {}, user: opts.user ?? USER }) as unknown as Request;
const res = (): { r: Response; c: { status: number; body: unknown } } => {
  const c = { status: 200, body: undefined as unknown };
  const r = {
    status(code: number) { c.status = code; return r; },
    json(p: unknown) { c.body = p; return r; },
    setHeader() { return r; },
  } as unknown as Response;
  return { r, c };
};

const VALID = { title: "Add a governance digest", body: "A weekly summary of open platform proposals for holders." };

beforeEach(() => {
  fx.state.holdWeight = 0n;
  fx.state.pyreToken = "0x1111111111111111111111111111111111111111";
  for (const f of [fx.platformHoldWeight, fx.proposalCreate, fx.proposalFindUnique, fx.proposalVoteUpsert, fx.getErc20Balance]) f.mockClear();
});

describe("submit (≥3% $PYRE gate)", () => {
  it("rejects a wallet below the 3% floor without creating a proposal", async () => {
    fx.state.holdWeight = 29_000_000_000_000n; // 2.9% of supply
    const { r } = res();
    await expect(submitProposalHandler(req({ body: VALID }), r)).rejects.toMatchObject({
      status: 403,
      message: "insufficient_hold",
    });
    expect(fx.proposalCreate).not.toHaveBeenCalled();
  });

  it("creates the proposal for a wallet at exactly the 3% floor", async () => {
    fx.state.holdWeight = 30_000_000_000_000n; // exactly 3%
    const { r, c } = res();
    await submitProposalHandler(req({ body: VALID }), r);
    expect(c.status).toBe(201);
    expect(fx.proposalCreate).toHaveBeenCalledTimes(1);
    expect(fx.proposalCreate.mock.calls[0]?.[0]).toMatchObject({ data: { authorId: "u1", title: VALID.title, body: VALID.body } });
    expect(c.body).toMatchObject({ id: "prop_1", status: "OPEN", weightUnits: "0", votes: 0, comments: 0, votedByMe: false, backed: false });
  });

  it("refuses every submission until $PYRE launches", async () => {
    fx.state.pyreToken = undefined;
    fx.state.holdWeight = 30_000_000_000_000n;
    const { r } = res();
    await expect(submitProposalHandler(req({ body: VALID }), r)).rejects.toMatchObject({
      status: 503,
      message: "pyre_not_launched",
    });
    expect(fx.platformHoldWeight).not.toHaveBeenCalled();
    expect(fx.proposalCreate).not.toHaveBeenCalled();
  });
});

describe("vote (any positive holder)", () => {
  it("rejects a zero-weight wallet before writing a vote", async () => {
    fx.state.holdWeight = 0n;
    const { r } = res();
    await expect(voteProposalHandler(req({ params: { id: "prop_1" } }), r)).rejects.toMatchObject({
      status: 403,
      message: "must_hold_pyre",
    });
    expect(fx.proposalVoteUpsert).not.toHaveBeenCalled();
  });

  it("upserts the vote with the caller's current capped weight", async () => {
    fx.state.holdWeight = 12_345n;
    const { r, c } = res();
    await voteProposalHandler(req({ params: { id: "prop_1" } }), r);
    expect(fx.proposalVoteUpsert).toHaveBeenCalledTimes(1);
    expect((fx.proposalVoteUpsert.mock.calls[0] as unknown[])?.[0]).toMatchObject({
      where: { proposalId_userId: { proposalId: "prop_1", userId: "u1" } },
      create: { proposalId: "prop_1", userId: "u1", weight: dec(12_345n) },
      update: { weight: dec(12_345n) },
    });
    expect(c.body).toMatchObject({ ok: true, weightUnits: "12345" });
  });
});
