import { describe, expect, it } from "vitest";
import { AppChainDto, BountyBody, BuildEventPayload, CreateLaunchBody, EvmAddress, LAUNCH_PHASE, MAX_CHARGE_USD, PyreManifest, TopupBody, TxHash, WithdrawBody } from "./index.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const HASH = "0x248e5cec83428ef05995702ff514acd1b7c472422c98e8c3e611ea07415af4b3";

describe("EvmAddress", () => {
  it("canonicalises lowercase input to the EIP-55 checksum", () => {
    expect(EvmAddress.parse(USDG.toLowerCase())).toBe(USDG);
    expect(EvmAddress.parse(USDG)).toBe(USDG);
    // All-uppercase hex is also checksum-agnostic per EIP-55 and must be accepted.
    expect(EvmAddress.parse(`0x${USDG.slice(2).toUpperCase()}`)).toBe(USDG);
  });

  it("rejects a mixed-case address whose checksum does not match, since that is a typo", () => {
    const typo = `${USDG.slice(0, -1)}${USDG.endsWith("8") ? "9" : "8"}`;
    expect(EvmAddress.safeParse(typo).success).toBe(false);
    expect(EvmAddress.safeParse("0x5fc5360d0400a0Fd4f2af552ADD042D716F1d168").success).toBe(false);
  });

  it("rejects anything that is not 20 bytes of 0x-hex", () => {
    for (const bad of [
      "",
      "5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d16",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d1680",
      "0xZZc5360D0400a0Fd4f2af552ADD042D716F1d168",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      ` ${USDG}`,
    ]) {
      expect(EvmAddress.safeParse(bad).success).toBe(false);
    }
  });
});

describe("TxHash", () => {
  it("accepts a 32-byte hash and lowercases it", () => {
    expect(TxHash.parse(HASH)).toBe(HASH);
    expect(TxHash.parse(HASH.toUpperCase().replace("0X", "0x"))).toBe(HASH);
  });

  it("rejects addresses, short hashes and base58 signatures", () => {
    for (const bad of [USDG, HASH.slice(0, -2), `${HASH}00`, HASH.slice(2), "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"]) {
      expect(TxHash.safeParse(bad).success).toBe(false);
    }
  });
});

describe("money bodies", () => {
  it("withdraws only ETH or USDG to a checksummed address", () => {
    const parsed = WithdrawBody.parse({ asset: "USDG", to: USDG.toLowerCase(), amount: 12.5 });
    expect(parsed.to).toBe(USDG);
    expect(WithdrawBody.safeParse({ asset: "SOL", to: USDG, amount: 1 }).success).toBe(false);
    expect(WithdrawBody.safeParse({ asset: "ETH", to: "0x5fc5360d0400a0Fd4f2af552ADD042D716F1d168", amount: 1 }).success).toBe(false);
    expect(WithdrawBody.safeParse({ asset: "ETH", to: USDG, amount: 0 }).success).toBe(false);
  });

  it("denominates top-ups and bounties in ETH with a sane ceiling", () => {
    expect(TopupBody.parse({ eth: 0.05 })).toEqual({ eth: 0.05 });
    expect(TopupBody.safeParse({ sol: 0.05 }).success).toBe(false);
    expect(TopupBody.safeParse({ eth: 1001 }).success).toBe(false);
    expect(BountyBody.safeParse({ title: "Fix login", description: "Login breaks on Safari", eth: 0.01 }).success).toBe(true);
    expect(BountyBody.safeParse({ title: "Fix login", description: "Login breaks on Safari", eth: 0 }).success).toBe(false);
  });

  it("records bounty claims in wei to a checksummed claimant", () => {
    const ok = BuildEventPayload.parse({ type: "BOUNTY_CLAIMED", bountyId: "b1", amountWei: "10000000000000000", claimant: USDG.toLowerCase() });
    expect(ok).toEqual({ type: "BOUNTY_CLAIMED", bountyId: "b1", amountWei: "10000000000000000", claimant: USDG });
    expect(BuildEventPayload.safeParse({ type: "BOUNTY_CLAIMED", bountyId: "b1", amount: "1", claimant: USDG }).success).toBe(false);
  });
});

describe("CreateLaunchBody", () => {
  const base = { name: "Inbox Zero", ticker: "INBOX", imageUrl: "https://cdn.pyre.test/logo.png", prompt: "An app that triages email for busy founders." };

  it("accepts http(s) logo and social URLs", () => {
    expect(CreateLaunchBody.safeParse({ ...base, twitter: "https://x.com/inboxzero", website: "http://inboxzero.example" }).success).toBe(true);
  });

  it("rejects javascript:, data: and other non-http schemes anywhere a URL is rendered or written on-chain", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "ftp://x.example/logo.png", "file:///etc/passwd"]) {
      expect(CreateLaunchBody.safeParse({ ...base, imageUrl: url }).success).toBe(false);
      expect(CreateLaunchBody.safeParse({ ...base, website: url }).success).toBe(false);
      expect(CreateLaunchBody.safeParse({ ...base, twitter: url }).success).toBe(false);
    }
  });
});

describe("PyreManifest prices", () => {
  it("caps every product and paid function at MAX_CHARGE_USD", () => {
    const manifest = (priceUsd: number) => ({
      name: "demo",
      products: [{ id: "pro", name: "Pro", priceUsd, kind: "ONE_TIME" }],
      functions: [{ name: "summarize", priceUsd }],
    });
    expect(PyreManifest.safeParse(manifest(MAX_CHARGE_USD)).success).toBe(true);
    expect(PyreManifest.safeParse(manifest(MAX_CHARGE_USD + 0.01)).success).toBe(false);
    expect(PyreManifest.safeParse({ name: "demo", products: [{ id: "pro", name: "Pro", priceUsd: 1_000_000, kind: "ONE_TIME" }] }).success).toBe(false);
  });
});

describe("AppChainDto", () => {
  const live = {
    tokenAddress: "0x69C70006c20914435560F62220F867B71003785f",
    walletAddress: USDG,
    curveAddress: "0x6Db0F5651E1C3Ab406eE9214C7E13d601504D847",
    poolId: null,
    phase: LAUNCH_PHASE.CURVE,
    stakeEth: 0.002,
    feesEth: 0.361944,
    buybackEth: 0,
    progress: 0.023,
    graduationThresholdEth: 4.2,
    ponsUrl: "https://www.ponsfamily.com/launchpad/0x69C70006c20914435560F62220F867B71003785f",
    explorerUrl: "https://robinhoodchain.blockscout.com/token/0x69C70006c20914435560F62220F867B71003785f",
  };

  it("accepts a curve-phase coin and a graduated one with a 32-byte poolId", () => {
    expect(AppChainDto.parse(live)).toEqual(live);
    const graduated = { ...live, phase: LAUNCH_PHASE.POOL, poolId: "0xf6b8694ff537fa7d453a3d6abda8d211d1de3db067c66d0936fc292561e47e9e", progress: 1 };
    expect(AppChainDto.parse(graduated)).toEqual(graduated);
  });

  it("pins phase to the PONS enum and progress to the unit interval", () => {
    expect(AppChainDto.safeParse({ ...live, phase: 4 }).success).toBe(false);
    expect(AppChainDto.safeParse({ ...live, phase: "BONDING" }).success).toBe(false);
    expect(AppChainDto.safeParse({ ...live, progress: 1.01 }).success).toBe(false);
    expect(AppChainDto.safeParse({ ...live, poolId: live.curveAddress }).success).toBe(false);
  });

  it("allows a coin that has not launched yet", () => {
    const draft = { ...live, tokenAddress: null, curveAddress: null, ponsUrl: null, explorerUrl: null, feesEth: 0, progress: 0 };
    expect(AppChainDto.parse(draft)).toEqual(draft);
  });
});
