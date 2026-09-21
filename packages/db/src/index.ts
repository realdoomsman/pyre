import { Prisma, PrismaClient } from "@prisma/client";

export * from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __pyrePrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__pyrePrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalThis.__pyrePrisma = prisma;

/*
 * Wei and token base-unit columns are `Decimal @db.Decimal(78, 0)` because int64 tops out at
 * 9.22e18 — a single 10 ETH fee or any 18-decimal token balance overflows Postgres BIGINT.
 * Application code keeps working in `bigint`; convert at the Prisma boundary with these.
 */
export type Decimalish = Prisma.Decimal | bigint | number | string | null | undefined;

/** bigint (or integer string) → Prisma.Decimal for writes. */
export const dec = (v: bigint | number | string): Prisma.Decimal => new Prisma.Decimal(typeof v === "bigint" ? v.toString() : v);

/** Prisma.Decimal (or anything integral) → bigint for reads; null/undefined → 0n. */
export const big = (v: Decimalish): bigint => {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v);
  return BigInt(v.toFixed(0));
};
