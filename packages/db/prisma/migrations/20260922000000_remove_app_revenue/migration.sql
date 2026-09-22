-- Apps built on Pyre are free to use: no in-app money, no app revenue, no app-coin buyback/burn.
-- $PYRE buy-and-burn (PyreBurn, BuybackStatus) stays.

-- DropForeignKey
ALTER TABLE "RevenueEvent" DROP CONSTRAINT "RevenueEvent_appId_fkey";

-- DropForeignKey
ALTER TABLE "RevenueEvent" DROP CONSTRAINT "RevenueEvent_buybackId_fkey";

-- DropForeignKey
ALTER TABLE "Buyback" DROP CONSTRAINT "Buyback_appId_fkey";

-- DropForeignKey
ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_appId_fkey";

-- DropForeignKey
ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_userId_fkey";

-- DropForeignKey
ALTER TABLE "AdImpression" DROP CONSTRAINT "AdImpression_appId_fkey";

-- DropIndex
DROP INDEX "App_revenueMicros_idx";

-- AlterTable
ALTER TABLE "App" DROP COLUMN "revenueMicros",
DROP COLUMN "buybackWei",
DROP COLUMN "burnedTokens",
DROP COLUMN "pendingRevenueMicros",
DROP COLUMN "firstRevenueAt";

-- DropTable
DROP TABLE "RevenueEvent";

-- DropTable
DROP TABLE "Buyback";

-- DropTable
DROP TABLE "Purchase";

-- DropTable
DROP TABLE "AdImpression";

-- DropTable
DROP TABLE "AdCampaign";

-- DropTable
DROP TABLE "DailyAppCharge";

-- DropEnum
DROP TYPE "RevenueSource";

-- DropEnum
DROP TYPE "AdStatus";
