import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { decodeEventData } from "./events.js";
import { bn } from "./read.js";
import { fillFromEvent } from "./trades.js";

/*
 * Real event-CPI inner-instruction payloads captured from mainnet on 2026-09-22 (signatures in
 * the comments). They pin the SDK decoders and the fee accounting `fillFromEvent` relies on.
 */
// 35FAoG9h41sXd79bs9AvwcVxUii2pENYSyjbMfzhLLeE3e8kaNZ4Zvb1D6nekkmLFHdTSDPqs946vJQdWqEzgmt5 — curve sell, non-mayhem, 95/30 bps
const CURVE_SELL =
  "25cufgucELvf9JiUdsFnVGcVzgjnwVPnE213cGvnis4xWws2qq5hs2LEFDKw6MHgkUFVL7Xe3FJMq7sbYqdtakHytGMx1GaZt5aWHmHn7RRJncaerCKJS1aeoG9WMR2GhQ5wsgT6UBEnTL5U8GnAKKCfAsKJqqaBpDg2mL6SuFhHPBjLryfdGntFVeMej2715PJEgVPC9rzhLMDVFzweL1DBfiQ3KRmkEacse1fbZbXje2o9w7CUXpb983KXSu8MkA1g2eDwwX7oPARJEdxnNJLnq7TZy2P526c73djsKLFe5yjAZ1KXze1xcE7QWr8yvJGkvHKeQnTZWPkAgq6U5cLRjMPKg5A8JEiWzuVoHETjx5TubnYqVUf6MbZ9wyfGEMJY4tZ6xEfAKCvcFhx3EkKFEcVfZqyJrxW3y5WmqaWQHsWV1XmW1s7pAMz8vGR9yBFweVsxV2XxDb7J8wmWXgHCma6yLetNoRXhZ4sEySEqrF71Deh6rH79VTuZ3d2WYF3doyU9k2N3";
// 38sUKnndu1SsjYHPKU3emjWkvpk3WMDMbt1WqCT7dz9RAy1GudoustsR2brKEDXfsSeuaoS2wCJokYjbWjS5Gbqh — curve buy on a mayhem coin (zero fees)
const CURVE_BUY_MAYHEM =
  "FBrYRSy1kwJFa1ngcrZxo8kETvwSpJ3AbhWcJQrGKfpxwdEp5udFctiGVkx1LuE1K5qVB9uoXL2FRvgMKwRx85fRaraipwDyHpk5d6XT3G3xUczrRDviCKQVTVtmVTKUjJAQYyPLzZHGBM9EyLseSd9HZobbdet5sT5HHHYwWA3hUfZGrciiaBMUpgrEZZRhwqLMhdPi5Q6RdKKqRbYDkGgUBqFTqMcmha9qQ9f6zBrkK6EEx9yAgfSZDGt9azDjje2474RxcbdDEt4jASRJs3WPX68KhLLaQoznNhWpnyoU2QFpC7WGTFw2UR4M2Cg5xa7CLchragdV3rQXFPwLnfetxb2EyWjWgQqrJjF7LiAgg1JXkHer8tY3GU2yBxqAw3stRWgxfU7P5iMD8TsmVtAHavF2RAzQYtL9vaHUG8XTyS4Wt53e9NkNiXDEfUhTXadm7P42kSCMff6nTPTdasg5LCmwZrhsTmm27RoMFnMJCFq6diFmvfunSFsy3mpC4pRCYxUKCs";
// 4YRPw3jASauDQPsem4Vjb7omt9wbPFPtrcwmwzmbyLqj2NrC1SUshpxkKmqtrzQxFBtpLR6wUpHKjwgSiDKwg8uJ — PumpSwap buy on pool 6SHba4Ej…
const AMM_BUY =
  "QcLsKX1K4jMVSCi449Y1wiFjwT4iSAfbtGV6ASfsY6WzK6iu4WScXb15NYa1MmvGV1L21FBgNZEm4QUvjWtXFEtxeKWkWTB8DakY9TToSyntAgWNTybwD3PE9aA5BA9HdTFejXmDMaaNDffKwU2Fj3xcpQmqpTxpevrpwheXmkWFHf2tgF2Woik6p4JtwEbspXUaxRcDPb1UvGNVC6cGVP4JpZB2ysiYJrdNs4PmstedKodViE6idYiTSzATQ16MFQ2gsqkG3D6pdvxUuZKYCStA6MqcdYyo5ptYp6b4bq2yJoF4ej6BieNyKZXs8hF3678bFTAbFrBavskmB7hVJ1rQeFr2Tv1R7ruh1Ue8UtXdUmWN3bxD2nM7HejqZL1RPE9Mfaj2Qken18VSTbRR8AYm152EoFo8fDEGRoKDT2dGtH85Wi3x7rcgYjuSmWR8H1j2LN4WCebCezJao1bV1tWy9bdW57sfPozQSCCPHHBmhhmnDXyvYZHodzHxU2Hpw1wuZVVeyBHv4Hy3NaeisudkAGHrTDzeoVnU4RQBxJbr11xGPQ2jwrMw9skm1TvHzXcfsLqsyJGc8RCHZmmBm3qZywQituFhYs5keKbpUR3RPi36rzu6ppPSRjcfSJDU6CpFY4vy9cN6Xp8f8jqAgtZmiHiF";
// 5XudvHynBpRQobJ6ULc9MT8QanCT46m7wU8jp358r4R7aqLaH7gggzayMEUxZkx2z1Dh1CNgQGVGuR4GmpYionuH — PumpSwap sell on the same pool
const AMM_SELL =
  "3WpVFTH6N5gEG5rjeG9cr8H4YzZGgZnwi6CL9PYwGvhW5Gk3ujpj8VoUHC9PBS2RJLJMec4W7YnzaQhAEwYJpZbravijbS8gfMx9Yrpsd7BKGMyFznBi9nTyaT2wRt8KT8bh9PQEuMXxJ3Fqrzo7qn5bEP1BuNyKed26Zbrymn43fQE1WZni2DJidqYGeBPZXTYgH5QMWs3BD7E1bVSLJMuS6JXRXXXPhtosFSvGMPMaGhkd728wdzT7wvgoHPrttJeyAsYv78fyaoKhDPE3dp42YD4MdfGL27zkv4hUSsUFgKJQ6G9zP2C5AA5feMb2ofrh3iDXC4tNE9r7cHZ2HEvaSEWd3DdbEGJG1N6qBZTpVvNp28x6w9BjgFqZDRnc7ixykmKcsVMq9hV7npXJ2uSU4gdYUMLGQWaXBnsCzTjeY17oPYn8pCchRPXGJWW6Q9JusKNu4emTWRnjRWx1ntcziMUCnYqzQ5AxGQVhz3yYAYDjmDZs6TgPaYuhQrDR7LXhX5rN1ATGdUKb8w8zWqnr5VHpu6zRHQAN6sYMJpEAccGofUKfqhXriDupqyN8xvJmhquqSKixgBDUqhvmxZoukrT";

const MINT = new PublicKey("24rmto6q4X2vfYPxxYcmbhRA92przKHyXGt6Lbdfpump");
const POOL = new PublicKey("6SHba4EjRggfc2LKxLHS4xSicPyunYGHi8BM8JwSe5WW");
const OTHER = PublicKey.default;
const data = (b58: string): Buffer => Buffer.from(bs58.decode(b58));

describe("pump event decoding", () => {
  it("decodes a curve TradeEvent and its fee split (protocol 95 bps incl. buyback half, creator 30 bps)", () => {
    const ev = decodeEventData("pump", data(CURVE_SELL));
    expect(ev?.kind).toBe("trade");
    if (ev?.kind !== "trade") return;
    const e = ev.event;
    expect(e.mint.equals(MINT)).toBe(true);
    expect(e.isBuy).toBe(false);
    expect(e.user.toBase58()).toBe("3N2kMgU52nC8QsjYdK9VCBUNLAJSCpXbcM4FxMiBZyX3");
    expect(bn(e.solAmount)).toBe(1_069_281_578n);
    expect(bn(e.tokenAmount)).toBe(9_627_228_893_554n);
    expect(bn(e.feeBasisPoints)).toBe(95n);
    expect(bn(e.creatorFeeBasisPoints)).toBe(30n);
    expect(bn(e.fee)).toBe(10_158_175n);
    expect(bn(e.buybackFee)).toBe(5_079_087n); // half the protocol fee, carved out of it
    expect(bn(e.creatorFee)).toBe(3_207_845n);
    expect(Number(bn(e.fee)) / Number(bn(e.solAmount))).toBeCloseTo(0.0095, 6);
    expect(Number(bn(e.creatorFee)) / Number(bn(e.solAmount))).toBeCloseTo(0.003, 6);
    expect(bn(e.virtualQuoteReserves)).toBe(bn(e.virtualSolReserves));
  });

  it("maps fills: sells net of fees, buys gross, other coins ignored", () => {
    const sell = fillFromEvent(decodeEventData("pump", data(CURVE_SELL))!, MINT, OTHER);
    expect(sell).toMatchObject({ side: "sell", wallet: "3N2kMgU52nC8QsjYdK9VCBUNLAJSCpXbcM4FxMiBZyX3", tokenUnits: 9_627_228_893_554n, quoteNative: 1_069_281_578n - 10_158_175n - 3_207_845n });
    expect(sell!.priceNative).toBeCloseTo((Number(sell!.quoteNative) / 9_627_228_893_554) * 1e-3, 18);
    expect(fillFromEvent(decodeEventData("pump", data(CURVE_SELL))!, OTHER, OTHER)).toBeNull();

    const buy = decodeEventData("pump", data(CURVE_BUY_MAYHEM))!;
    expect(buy.kind).toBe("trade");
    const mayhemMint = new PublicKey("7Piw91zS8GyfSBxwZJbnwVEYZUGTDUCnqqaVggR1pump");
    expect(fillFromEvent(buy, mayhemMint, OTHER)).toMatchObject({ side: "buy", tokenUnits: 1_926_519_723_471n, quoteNative: 60_734_171n });
  });

  it("decodes PumpSwap BuyEvent / SellEvent and uses the user's total in / out", () => {
    const buy = fillFromEvent(decodeEventData("amm", data(AMM_BUY))!, OTHER, POOL);
    expect(buy).toMatchObject({ side: "buy", wallet: "5dEZWjYSWfRtM4ubKbu3xHXhovMMzvELsv5rwrkter4W", tokenUnits: 6_092_689_200_286n, quoteNative: 2_946_002_830n });
    const ev = decodeEventData("amm", data(AMM_BUY))!;
    if (ev.kind !== "ammBuy") throw new Error("expected ammBuy");
    // userQuoteAmountIn is the sum of the components pump reports.
    expect(bn(ev.event.userQuoteAmountIn)).toBe(bn(ev.event.quoteAmountIn) + bn(ev.event.lpFee) + bn(ev.event.protocolFee) + bn(ev.event.coinCreatorFee));
    expect(bn(ev.event.coinCreatorFeeBasisPoints)).toBe(95n); // 420–1470 SOL mcap tier at the time

    const sell = fillFromEvent(decodeEventData("amm", data(AMM_SELL))!, OTHER, POOL);
    expect(sell).toMatchObject({ side: "sell", wallet: "Cs4zpkT9sPWw26LWTU8UmLJLDmNrHWSJw6ZDZphykwkC", tokenUnits: 434_057_170_830n, quoteNative: 213_547_241n - 427_095n - 106_774n - 2_028_699n });
    expect(fillFromEvent(decodeEventData("amm", data(AMM_SELL))!, OTHER, OTHER)).toBeNull();
  });

  it("ignores payloads that are not event CPIs or belong to the other program", () => {
    expect(decodeEventData("pump", Buffer.from("not an event"))).toBeNull();
    expect(decodeEventData("amm", data(CURVE_SELL))).toBeNull();
    expect(decodeEventData("pump", data(AMM_BUY))).toBeNull();
  });
});
