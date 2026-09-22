import { describe, expect, it } from "vitest";
import {
  EXPLORER_URL,
  RESERVED_SLUGS,
  WEI_PER_ETH,
  clamp,
  decimalToUnits,
  ethToWei,
  explorerAddressUrl,
  explorerTokenUrl,
  explorerTxUrl,
  fnv1a32,
  formatEth,
  formatUsd,
  ponsUrl,
  shortAddr,
  slugify,
  usdFromWei,
  weiToEth,
} from "./index.js";

describe("ETH conversions", () => {
  it("agrees with the wei constant on whole ETH", () => {
    expect(WEI_PER_ETH).toBe(10n ** 18n);
    expect(ethToWei(1)).toBe(WEI_PER_ETH);
    expect(weiToEth(WEI_PER_ETH)).toBe(1);
    expect(weiToEth(0)).toBe(0);
  });

  it("does not leak float error into wei", () => {
    // 0.1 is 0.1000000000000000055… in IEEE-754; naive `round(eth * 1e18)` yields 100000000000000006n.
    expect(ethToWei(0.1)).toBe(100_000_000_000_000_000n);
    expect(ethToWei(0.05)).toBe(50_000_000_000_000_000n);
    expect(ethToWei(0.0005)).toBe(500_000_000_000_000n);
    expect(ethToWei(1.000000001)).toBe(1_000_000_001_000_000_000n);
    expect(ethToWei(4.2)).toBe(4_200_000_000_000_000_000n);
  });

  it("handles the magnitudes a double prints in exponent form", () => {
    expect(ethToWei(1e-9)).toBe(1_000_000_000n); // 1 gwei
    expect(ethToWei(1e-18)).toBe(1n);
    expect(ethToWei(1e-19)).toBe(0n); // below one wei: truncated, never rounded up
    expect(ethToWei(1e21)).toBe(10n ** 39n);
    expect(ethToWei(-0.5)).toBe(-500_000_000_000_000_000n);
  });

  it("rejects non-finite amounts instead of producing garbage wei", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => ethToWei(bad)).toThrow(RangeError);
    }
  });

  it("round-trips display amounts within a wei", () => {
    for (const eth of [0.000000001, 0.002, 0.37, 1, 1.5, 12.3456789, 1000, 123456.789]) {
      const wei = ethToWei(eth);
      expect(Math.abs(weiToEth(wei) - eth)).toBeLessThan(1e-9);
      expect(ethToWei(weiToEth(wei))).toBe(wei);
    }
  });

  it("accepts wei as bigint, number or decimal string", () => {
    expect(weiToEth(500_000_000_000_000_000n)).toBe(0.5);
    expect(weiToEth(500_000_000_000_000_000)).toBe(0.5);
    expect(weiToEth("500000000000000000")).toBe(0.5);
  });

  it("prices wei in USD at the given ETH price", () => {
    expect(usdFromWei(WEI_PER_ETH, 2703.89)).toBeCloseTo(2703.89, 9);
    expect(usdFromWei(50_000_000_000_000_000n, 2703.89)).toBeCloseTo(135.1945, 9);
    expect(usdFromWei(0n, 2703.89)).toBe(0);
    // A zero price must not produce NaN/Infinity: fee sweeps run before the price feed warms up.
    expect(usdFromWei(WEI_PER_ETH, 0)).toBe(0);
  });
});

describe("decimalToUnits", () => {
  it("parses USDG form input exactly at 6 decimals", () => {
    expect(decimalToUnits("1", 6)).toBe(1_000_000n);
    expect(decimalToUnits("0.5", 6)).toBe(500_000n);
    expect(decimalToUnits("12.345678", 6)).toBe(12_345_678n);
    expect(decimalToUnits("1.", 6)).toBe(1_000_000n);
  });

  it("truncates digits past the asset's precision instead of rounding them up", () => {
    expect(decimalToUnits("0.0000019", 6)).toBe(1n);
    expect(decimalToUnits("0.0000001", 6)).toBe(0n);
    expect(decimalToUnits("1.5e-7", 6)).toBe(0n);
  });

  it("understands exponents in either direction", () => {
    expect(decimalToUnits("2.5e-3", 18)).toBe(2_500_000_000_000_000n);
    expect(decimalToUnits("1E+3", 6)).toBe(1_000_000_000n);
    expect(decimalToUnits("  42  ", 0)).toBe(42n);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", ".", "1,5", "0x10", "1e", "abc", "1.2.3", "+1"]) {
      expect(() => decimalToUnits(bad, 18)).toThrow(RangeError);
    }
  });
});

describe("slugify", () => {
  it("normalizes ordinary names", () => {
    expect(slugify("My Cool App")).toBe("my-cool-app");
    expect(slugify("InboxZero")).toBe("inboxzero");
    expect(slugify("Deadlinks 2.0")).toBe("deadlinks-2-0");
  });

  it("strips diacritics instead of turning them into separators", () => {
    expect(slugify("Über Café")).toBe("uber-cafe");
    expect(slugify("Café Münster")).toBe("cafe-munster");
    expect(slugify("Señor Ríos")).toBe("senor-rios");
  });

  it("neutralizes hostile input", () => {
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify("<script>alert(1)</script>")).toBe("script-alert-1-script");
    expect(slugify("app/../admin")).toBe("app-admin");
    expect(slugify("a?b=c#d")).toBe("a-b-c-d");
    expect(slugify("  spaced  out  ")).toBe("spaced-out");
    expect(slugify("...hello...")).toBe("hello");
  });

  it("always yields a non-empty slug", () => {
    for (const hostile of ["", "   ", "🚀🚀🚀", "!!!", "---", "。。。", "\u0000\u0001"]) {
      expect(slugify(hostile)).toBe("app");
    }
  });

  it("never produces a slug that is an invalid DNS label", () => {
    // Regression: the hyphen trim used to run before the 40-char clamp, so truncating mid-word
    // left a trailing "-" — an RFC 1123 violation that breaks `<slug>.<APP_DOMAIN>` certificates.
    const hostile = [
      `${"a".repeat(39)} b`,
      `${"a".repeat(40)} tail`,
      `${"word ".repeat(20)}end`,
      "a".repeat(200),
      `-${"x".repeat(45)}-`,
      "The Quick Brown Fox Jumps Over The Lazy Dog Again",
      "🚀 ".repeat(30),
      `${"ab-".repeat(20)}`,
    ];
    for (const name of hostile) {
      const slug = slugify(name);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug.length).toBeLessThanOrEqual(40);
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
      expect(slug).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
    expect(slugify(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });
});

describe("RESERVED_SLUGS", () => {
  it("blocks the hostnames the platform itself serves", () => {
    for (const name of ["www", "api", "app", "admin", "pyre", "ship", "static", "assets", "mail", "docs", "status", "cdn", "dev"]) {
      expect(RESERVED_SLUGS[name]).toBe(true);
    }
    expect(RESERVED_SLUGS["inboxzero"]).toBeUndefined();
  });

  it("cannot be bypassed by casing or padding, because slugify maps back onto the reserved key", () => {
    // launch.ts checks RESERVED_SLUGS[slugify(name)], so every spelling that slugifies to a
    // reserved word must be caught by that single lookup.
    for (const key of Object.keys(RESERVED_SLUGS)) {
      for (const variant of [key.toUpperCase(), ` ${key} `, `${key}!`, `.${key}.`]) {
        expect(RESERVED_SLUGS[slugify(variant)]).toBe(true);
      }
    }
  });

  it("is a plain lookup table with only true values, so a missing key is falsy", () => {
    for (const value of Object.values(RESERVED_SLUGS)) expect(value).toBe(true);
    expect(RESERVED_SLUGS["definitely-not-reserved"] ?? false).toBe(false);
  });
});

describe("display helpers", () => {
  it("formats USD by magnitude without dropping the unit", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(96)).toBe("$96.00");
    expect(formatUsd(4213.55)).toBe("$4213.55");
    expect(formatUsd(9999.99)).toBe("$9999.99");
    expect(formatUsd(10_000)).toBe("$10.0k");
    expect(formatUsd(999_999)).toBe("$1000.0k");
    expect(formatUsd(1_000_000)).toBe("$1.00M");
    expect(formatUsd(4_213_550)).toBe("$4.21M");
  });

  it("formats ETH grouped with bounded decimals and no trailing zeros", () => {
    expect(formatEth(0n)).toBe("0 ETH");
    expect(formatEth(WEI_PER_ETH)).toBe("1 ETH");
    expect(formatEth(50_000_000_000_000_000n)).toBe("0.05 ETH");
    expect(formatEth(1_234_567_800_000_000_000_000n)).toBe("1,234.5678 ETH");
    expect(formatEth(123_456_789_000_000_000n)).toBe("0.1235 ETH");
    expect(formatEth(500_000_000_000_000n, 6)).toBe("0.0005 ETH");
    // Below the display precision it rounds to zero rather than printing exponent notation.
    expect(formatEth(1n)).toBe("0 ETH");
  });

  it("shortens only addresses that are actually long enough to shorten", () => {
    expect(shortAddr("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")).toBe("0x5f…d168");
    expect(shortAddr("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", 6)).toBe("0x5fc5…F1d168");
    expect(shortAddr("short")).toBe("short");
    // Shortening only pays off past 2n+1 characters; at exactly 2n+1 the address is left intact.
    expect(shortAddr("123456789", 4)).toBe("123456789");
    expect(shortAddr("1234567890", 4)).toBe("1234…7890");
  });

  it("builds the PONS and Blockscout deep links the UI and feed posts rely on", () => {
    const token = "0x69C70006c20914435560F62220F867B71003785f";
    const hash = "0x248e5cec83428ef05995702ff514acd1b7c472422c98e8c3e611ea07415af4b3";
    expect(ponsUrl(token)).toBe(`https://www.ponsfamily.com/launchpad/${token}`);
    expect(explorerTxUrl(hash)).toBe(`${EXPLORER_URL}/tx/${hash}`);
    expect(explorerAddressUrl(token)).toBe(`${EXPLORER_URL}/address/${token}`);
    expect(explorerTokenUrl(token)).toBe(`${EXPLORER_URL}/token/${token}`);
    // Operators can point at a different Blockscout (e.g. a mirror) without changing the path format.
    expect(explorerTxUrl(hash, "https://explorer.example")).toBe(`https://explorer.example/tx/${hash}`);
  });

  it("clamps to the closed interval", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 0)).toBe(0);
  });
});

describe("fnv1a32", () => {
  it("is deterministic and stays inside uint32, since it derives HD wallet indexes", () => {
    const a = fnv1a32("clh1q2w3e4r5t6y7u8i9o0p");
    expect(fnv1a32("clh1q2w3e4r5t6y7u8i9o0p")).toBe(a);
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });

  it("separates ids that differ only in the last character", () => {
    const seen: Record<number, string> = {};
    for (let i = 0; i < 2000; i++) {
      const id = `app_${i}`;
      const h = fnv1a32(id);
      expect(seen[h]).toBeUndefined();
      seen[h] = id;
    }
  });
});
