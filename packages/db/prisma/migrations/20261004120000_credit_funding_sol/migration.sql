-- Model-credit top-ups are paid from the treasury Solana wallet in SOL instead of treasury ETH on
-- Robinhood Chain. `originChain` records which chain paid; every existing row was paid in ETH, so the
-- column is backfilled 'robinhood' and only then defaults to 'solana' for new rows. `ethWei` becomes
-- `nativeWei`: lamports on solana rows, wei on the old robinhood rows.

-- AlterTable
ALTER TABLE "CreditFunding" ADD COLUMN "originChain" "Chain" NOT NULL DEFAULT 'robinhood';
ALTER TABLE "CreditFunding" ALTER COLUMN "originChain" SET DEFAULT 'solana';
ALTER TABLE "CreditFunding" RENAME COLUMN "ethWei" TO "nativeWei";
