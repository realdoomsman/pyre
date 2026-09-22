-- Launch venues: a coin lives on a chain + launchpad pair. Every existing row is a PONS v2 launch on
-- Robinhood Chain, which is also the column default, so the backfill is the default itself.
-- Every `…Wei` column keeps its name and now means native base units of the app's chain.

-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('robinhood', 'solana');

-- CreateEnum
CREATE TYPE "Launchpad" AS ENUM ('pons_v2', 'pump_fun');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "solWallet" TEXT;

-- AlterTable
ALTER TABLE "App" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'robinhood',
ADD COLUMN "launchpad" "Launchpad" NOT NULL DEFAULT 'pons_v2';

-- Backfill (explicit, so a row created before the defaults existed can never be left ambiguous)
UPDATE "App" SET "chain" = 'robinhood', "launchpad" = 'pons_v2';

-- AlterTable
ALTER TABLE "FeeEvent" ADD COLUMN "coinBurnMicros" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "HolderBalance" ADD COLUMN "tag" TEXT;

-- The LAUNCH feed event now names the launchpad page generically.
UPDATE "BuildEvent"
SET "payload" = ("payload" - 'ponsUrl') || jsonb_build_object('launchpadUrl', "payload" -> 'ponsUrl')
WHERE "type" = 'LAUNCH' AND "payload" ? 'ponsUrl';

-- CreateTable
CREATE TABLE "CoinBurn" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "status" "BuybackStatus" NOT NULL DEFAULT 'PENDING',
    "usdMicros" BIGINT NOT NULL,
    "nativeWei" DECIMAL(78,0) NOT NULL,
    "tokensBought" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "tokensBurned" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "burnedUnits" DECIMAL(78,0),
    "attestHash" TEXT NOT NULL,
    "swapTx" TEXT,
    "burnTx" TEXT,
    "attestTx" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CoinBurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_solWallet_key" ON "User"("solWallet");

-- CreateIndex
CREATE INDEX "App_chain_status_idx" ON "App"("chain", "status");

-- CreateIndex
CREATE INDEX "CoinBurn_appId_createdAt_idx" ON "CoinBurn"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "CoinBurn_status_createdAt_idx" ON "CoinBurn"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "CoinBurn" ADD CONSTRAINT "CoinBurn_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;
