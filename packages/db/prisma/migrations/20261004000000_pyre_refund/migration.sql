-- PYRE holder refund program: holders of the Robinhood Chain PYRE at block 79819827 are refunded the
-- ETH they put in, paid in SOL from the REFUND ledger account. RefundHolder rows are loaded once
-- from data/pyre-refund-snapshot.json by apps/runner/scripts/load-refund-snapshot.mjs.

-- CreateEnum
CREATE TYPE "RefundPayoutStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "RefundHolder" (
    "address" TEXT NOT NULL,
    "balanceUnits" DECIMAL(78,0) NOT NULL,
    "currentBalanceUnits" DECIMAL(78,0) NOT NULL,
    "minBalanceUnits" DECIMAL(78,0) NOT NULL,
    "boughtUnits" DECIMAL(78,0) NOT NULL,
    "ethInWei" DECIMAL(78,0) NOT NULL,
    "ethOutWei" DECIMAL(78,0) NOT NULL,
    "owedWei" DECIMAL(78,0) NOT NULL,
    "settledWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "creditMicros" BIGINT NOT NULL DEFAULT 0,
    "paidMicros" BIGINT NOT NULL DEFAULT 0,
    "solWallet" TEXT,
    "linkedAt" TIMESTAMP(3),
    "linkedByUserId" TEXT,
    "linkPendingUntil" TIMESTAMP(3),

    CONSTRAINT "RefundHolder_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "RefundPayout" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "solWallet" TEXT NOT NULL,
    "usdMicros" BIGINT NOT NULL,
    "lamports" DECIMAL(78,0) NOT NULL,
    "solPriceUsd" DOUBLE PRECISION NOT NULL,
    "status" "RefundPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "txSig" TEXT,
    "error" TEXT,
    "lastValidBlockHeight" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "RefundPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundFeeCredit" (
    "signature" TEXT NOT NULL,
    "lamports" DECIMAL(78,0) NOT NULL,
    "usdMicros" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundFeeCredit_pkey" PRIMARY KEY ("signature")
);

-- CreateIndex
CREATE INDEX "RefundHolder_solWallet_idx" ON "RefundHolder"("solWallet");

-- CreateIndex
CREATE UNIQUE INDEX "RefundPayout_txSig_key" ON "RefundPayout"("txSig");

-- CreateIndex
CREATE INDEX "RefundPayout_status_createdAt_idx" ON "RefundPayout"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RefundPayout_address_createdAt_idx" ON "RefundPayout"("address", "createdAt");

-- AddForeignKey
ALTER TABLE "RefundPayout" ADD CONSTRAINT "RefundPayout_address_fkey" FOREIGN KEY ("address") REFERENCES "RefundHolder"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
