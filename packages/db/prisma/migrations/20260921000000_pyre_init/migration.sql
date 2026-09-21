-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('OPEN', 'PLANNED', 'BUILDING', 'SHIPPED', 'DECLINED');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('DRAFT', 'SPEC_READY', 'AWAITING_STAKE', 'LAUNCHING', 'LAUNCH_GATED', 'LIVE', 'DORMANT', 'KILLED', 'FAILED');

-- CreateEnum
CREATE TYPE "Template" AS ENUM ('WEB_TOOL', 'GAME', 'AGENT_API');

-- CreateEnum
CREATE TYPE "JobStage" AS ENUM ('SCAFFOLD', 'MVP', 'DEPLOY', 'VERIFY', 'ITERATE', 'SELF_HEAL', 'PR_REVIEW');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeeSource" AS ENUM ('CREATOR_FEE', 'FORK_ROYALTY', 'REVIVE_BUY', 'MANUAL');

-- CreateEnum
CREATE TYPE "RevenueSource" AS ENUM ('CHECKOUT', 'SUBSCRIPTION', 'X402', 'AD', 'EXTERNAL_SDK');

-- CreateEnum
CREATE TYPE "BuybackStatus" AS ENUM ('PENDING', 'SWAPPING', 'SWAPPED', 'BURNED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreditFundingStatus" AS ENUM ('PENDING', 'SWAPPED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('OPEN', 'SCHEDULED', 'DONE', 'REJECTED');

-- CreateEnum
CREATE TYPE "BountyStatus" AS ENUM ('OPEN', 'CLAIMED', 'PAYING', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PrStatus" AS ENUM ('OPEN', 'REVIEWING', 'APPROVED', 'REJECTED', 'MERGED');

-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXHAUSTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "googleSub" TEXT,
    "authWallet" TEXT,
    "walletIndex" SERIAL NOT NULL,
    "wallet" TEXT,
    "xHandle" TEXT,
    "xUserId" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "reputation" INTEGER NOT NULL DEFAULT 0,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "bannedAt" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'OPEN',
    "ownerNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalVote" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weight" DECIMAL(78,0) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalComment" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyWithdraw" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "usedMicros" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyWithdraw_pkey" PRIMARY KEY ("userId","day")
);

-- CreateTable
CREATE TABLE "DailyAppCharge" (
    "userId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "usedMicros" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyAppCharge_pkey" PRIMARY KEY ("userId","appId","day")
);

-- CreateTable
CREATE TABLE "App" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "spec" JSONB,
    "specApprovedAt" TIMESTAMP(3),
    "template" "Template" NOT NULL DEFAULT 'WEB_TOOL',
    "status" "AppStatus" NOT NULL DEFAULT 'DRAFT',
    "killedReason" TEXT,
    "launcherId" TEXT NOT NULL,
    "maintainerId" TEXT,
    "tokenAddress" TEXT,
    "walletAddress" TEXT,
    "keypairIndex" SERIAL NOT NULL,
    "launchPhase" INTEGER NOT NULL DEFAULT 0,
    "curveAddress" TEXT,
    "poolId" TEXT,
    "launchedAt" TIMESTAMP(3),
    "graduatedAt" TIMESTAMP(3),
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unsweptWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "escrowWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "launchBlock" BIGINT,
    "lastIndexedBlock" BIGINT,
    "launchTx" TEXT,
    "twitterUrl" TEXT,
    "websiteUrl" TEXT,
    "stakeWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "stakeTx" TEXT,
    "stakeRefundTx" TEXT,
    "stakeRefundedAt" TIMESTAMP(3),
    "forkOfId" TEXT,
    "budgetMicros" BIGINT NOT NULL DEFAULT 0,
    "spentMicros" BIGINT NOT NULL DEFAULT 0,
    "feesWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "revenueMicros" BIGINT NOT NULL DEFAULT 0,
    "buybackWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "burnedTokens" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "pendingRevenueMicros" BIGINT NOT NULL DEFAULT 0,
    "usersCount" INTEGER NOT NULL DEFAULT 0,
    "uptimeBps" INTEGER NOT NULL DEFAULT 10000,
    "healthy" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "lastHealthAt" TIMESTAMP(3),
    "priceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marketCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "holdersCount" INTEGER NOT NULL DEFAULT 0,
    "lastPriceAt" TIMESTAMP(3),
    "change24hPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume24hUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "liveVersion" INTEGER NOT NULL DEFAULT 0,
    "repoUrl" TEXT,
    "repoFullName" TEXT,
    "firstBuildAt" TIMESTAMP(3),
    "mvpLiveAt" TIMESTAMP(3),
    "firstRevenueAt" TIMESTAMP(3),
    "milestones" JSONB NOT NULL DEFAULT '[]',
    "growthEnabled" BOOLEAN NOT NULL DEFAULT false,
    "xAccount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "App_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildJob" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "stage" "JobStage" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "budgetMicros" BIGINT NOT NULL,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "model" TEXT,
    "sandboxId" TEXT,
    "instruction" TEXT,
    "taskIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prNumber" INTEGER,
    "reviewVerdict" TEXT,
    "summary" TEXT,
    "error" TEXT,
    "commitSha" TEXT,
    "deploymentId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildEvent" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "bundle" BYTEA NOT NULL,
    "bundleSha" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "commitSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeployFile" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "body" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,

    CONSTRAINT "DeployFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeEvent" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "source" "FeeSource" NOT NULL,
    "wei" DECIMAL(78,0) NOT NULL,
    "ethPriceUsd" DOUBLE PRECISION NOT NULL,
    "usdMicros" BIGINT NOT NULL,
    "buildMicros" BIGINT NOT NULL,
    "pyreMicros" BIGINT NOT NULL,
    "launcherMicros" BIGINT NOT NULL,
    "upstreamMicros" BIGINT NOT NULL DEFAULT 0,
    "creditsMicros" BIGINT NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueEvent" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "source" "RevenueSource" NOT NULL,
    "usdMicros" BIGINT NOT NULL,
    "payer" TEXT,
    "reference" TEXT,
    "purchaseId" TEXT,
    "buybackId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Buyback" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "status" "BuybackStatus" NOT NULL DEFAULT 'PENDING',
    "revenueMicros" BIGINT NOT NULL,
    "ethWei" DECIMAL(78,0) NOT NULL,
    "tokensBought" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "tokensBurned" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "burnedUnits" DECIMAL(78,0),
    "pyreMicros" BIGINT NOT NULL,
    "opsMicros" BIGINT NOT NULL,
    "attestHash" TEXT NOT NULL,
    "swapTx" TEXT,
    "burnTx" TEXT,
    "attestTx" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Buyback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditFunding" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "usdMicros" BIGINT NOT NULL,
    "ethWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "usdgUnits" BIGINT NOT NULL DEFAULT 0,
    "wallet" TEXT NOT NULL,
    "status" "CreditFundingStatus" NOT NULL DEFAULT 'PENDING',
    "swapTx" TEXT,
    "transferTx" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CreditFunding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "usdMicros" BIGINT NOT NULL,
    "payerWallet" TEXT NOT NULL,
    "txHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptQueueItem" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'OPEN',
    "weight" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vote" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weight" DECIMAL(78,0) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bounty" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "wei" DECIMAL(78,0) NOT NULL,
    "escrowTx" TEXT NOT NULL,
    "status" "BountyStatus" NOT NULL DEFAULT 'OPEN',
    "claimantId" TEXT,
    "claimantWallet" TEXT,
    "prNumber" INTEGER,
    "payoutTx" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "Bounty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "authorLogin" TEXT NOT NULL,
    "authorWallet" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "PrStatus" NOT NULL DEFAULT 'OPEN',
    "reviewSummary" TEXT,
    "mergeSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contributor" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mergedPrs" INTEGER NOT NULL DEFAULT 0,
    "earnedMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contributor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintainerVote" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateWallet" TEXT NOT NULL,
    "weight" DECIMAL(78,0) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintainerVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HolderBalance" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HolderBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "block" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "side" TEXT NOT NULL,
    "venue" TEXT NOT NULL DEFAULT 'CURVE',
    "wallet" TEXT NOT NULL,
    "tokenUnits" DECIMAL(78,0) NOT NULL,
    "quoteWei" DECIMAL(78,0) NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "t" INTEGER NOT NULL,
    "o" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "l" DOUBLE PRECISION NOT NULL,
    "c" DOUBLE PRECISION NOT NULL,
    "v" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppKv" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppKv_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppUserSession" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppUserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdImpression" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "advertiserAppId" TEXT NOT NULL,
    "usdMicros" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdImpression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbuseFlag" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbuseFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PyreStake" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "depositTx" TEXT NOT NULL,
    "withdrawTx" TEXT,
    "earnedMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "PyreStake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "advertiserAppId" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "targetUrl" TEXT NOT NULL,
    "cpmMicros" BIGINT NOT NULL,
    "budgetMicros" BIGINT NOT NULL,
    "spentMicros" BIGINT NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "status" "AdStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "reporter" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "deltaMicros" BIGINT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyComputeSpend" (
    "day" TEXT NOT NULL,
    "micros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "DailyComputeSpend_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "JobToken" (
    "token" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "budgetMicros" BIGINT NOT NULL,
    "spentMicros" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "JobToken_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconcileRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "checked" INTEGER NOT NULL DEFAULT 0,
    "drifted" INTEGER NOT NULL DEFAULT 0,
    "repaired" INTEGER NOT NULL DEFAULT 0,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconcileRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "User_authWallet_key" ON "User"("authWallet");

-- CreateIndex
CREATE UNIQUE INDEX "User_walletIndex_key" ON "User"("walletIndex");

-- CreateIndex
CREATE UNIQUE INDEX "User_wallet_key" ON "User"("wallet");

-- CreateIndex
CREATE INDEX "Proposal_status_createdAt_idx" ON "Proposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProposalVote_userId_idx" ON "ProposalVote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalVote_proposalId_userId_key" ON "ProposalVote"("proposalId", "userId");

-- CreateIndex
CREATE INDEX "ProposalComment_proposalId_createdAt_idx" ON "ProposalComment"("proposalId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "App_slug_key" ON "App"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "App_tokenAddress_key" ON "App"("tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "App_walletAddress_key" ON "App"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "App_keypairIndex_key" ON "App"("keypairIndex");

-- CreateIndex
CREATE UNIQUE INDEX "App_stakeTx_key" ON "App"("stakeTx");

-- CreateIndex
CREATE INDEX "App_status_idx" ON "App"("status");

-- CreateIndex
CREATE INDEX "App_revenueMicros_idx" ON "App"("revenueMicros");

-- CreateIndex
CREATE INDEX "App_createdAt_idx" ON "App"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BuildJob_deploymentId_key" ON "BuildJob"("deploymentId");

-- CreateIndex
CREATE INDEX "BuildJob_appId_createdAt_idx" ON "BuildJob"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "BuildJob_status_idx" ON "BuildJob"("status");

-- CreateIndex
CREATE INDEX "BuildJob_status_startedAt_idx" ON "BuildJob"("status", "startedAt");

-- CreateIndex
CREATE INDEX "BuildJob_appId_status_idx" ON "BuildJob"("appId", "status");

-- CreateIndex
CREATE INDEX "BuildEvent_appId_createdAt_idx" ON "BuildEvent"("appId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_appId_version_key" ON "Deployment"("appId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DeployFile_deploymentId_path_key" ON "DeployFile"("deploymentId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "FeeEvent_txHash_key" ON "FeeEvent"("txHash");

-- CreateIndex
CREATE INDEX "FeeEvent_appId_createdAt_idx" ON "FeeEvent"("appId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueEvent_purchaseId_key" ON "RevenueEvent"("purchaseId");

-- CreateIndex
CREATE INDEX "RevenueEvent_appId_createdAt_idx" ON "RevenueEvent"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "RevenueEvent_buybackId_idx" ON "RevenueEvent"("buybackId");

-- CreateIndex
CREATE INDEX "Buyback_appId_createdAt_idx" ON "Buyback"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditFunding_appId_status_idx" ON "CreditFunding"("appId", "status");

-- CreateIndex
CREATE INDEX "CreditFunding_status_createdAt_idx" ON "CreditFunding"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_txHash_key" ON "Purchase"("txHash");

-- CreateIndex
CREATE INDEX "Purchase_appId_userId_idx" ON "Purchase"("appId", "userId");

-- CreateIndex
CREATE INDEX "Purchase_status_idx" ON "Purchase"("status");

-- CreateIndex
CREATE INDEX "PromptQueueItem_appId_status_weight_idx" ON "PromptQueueItem"("appId", "status", "weight");

-- CreateIndex
CREATE UNIQUE INDEX "Vote_itemId_userId_key" ON "Vote"("itemId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Bounty_escrowTx_key" ON "Bounty"("escrowTx");

-- CreateIndex
CREATE INDEX "Bounty_appId_status_idx" ON "Bounty"("appId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_appId_number_key" ON "PullRequest"("appId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Contributor_appId_userId_key" ON "Contributor"("appId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintainerVote_appId_userId_key" ON "MaintainerVote"("appId", "userId");

-- CreateIndex
CREATE INDEX "HolderBalance_appId_amount_idx" ON "HolderBalance"("appId", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "HolderBalance_appId_wallet_key" ON "HolderBalance"("appId", "wallet");

-- CreateIndex
CREATE INDEX "Trade_appId_ts_idx" ON "Trade"("appId", "ts");

-- CreateIndex
CREATE INDEX "Trade_appId_block_idx" ON "Trade"("appId", "block");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_appId_txHash_side_wallet_tokenUnits_quoteWei_key" ON "Trade"("appId", "txHash", "side", "wallet", "tokenUnits", "quoteWei");

-- CreateIndex
CREATE INDEX "Candle_appId_interval_t_idx" ON "Candle"("appId", "interval", "t");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_appId_interval_t_key" ON "Candle"("appId", "interval", "t");

-- CreateIndex
CREATE UNIQUE INDEX "AppKv_appId_scope_key_key" ON "AppKv"("appId", "scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AppUserSession_appId_userId_key" ON "AppUserSession"("appId", "userId");

-- CreateIndex
CREATE INDEX "AdImpression_appId_createdAt_idx" ON "AdImpression"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "AbuseFlag_appId_resolved_idx" ON "AbuseFlag"("appId", "resolved");

-- CreateIndex
CREATE UNIQUE INDEX "PyreStake_depositTx_key" ON "PyreStake"("depositTx");

-- CreateIndex
CREATE INDEX "PyreStake_appId_withdrawnAt_idx" ON "PyreStake"("appId", "withdrawnAt");

-- CreateIndex
CREATE INDEX "PyreStake_wallet_idx" ON "PyreStake"("wallet");

-- CreateIndex
CREATE INDEX "AdCampaign_status_idx" ON "AdCampaign"("status");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE INDEX "LedgerEntry_account_createdAt_idx" ON "LedgerEntry"("account", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobToken_jobId_key" ON "JobToken"("jobId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_receivedAt_idx" ON "WebhookEvent"("provider", "receivedAt");

-- CreateIndex
CREATE INDEX "ReconcileRun_kind_createdAt_idx" ON "ReconcileRun"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVote" ADD CONSTRAINT "ProposalVote_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVote" ADD CONSTRAINT "ProposalVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalComment" ADD CONSTRAINT "ProposalComment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalComment" ADD CONSTRAINT "ProposalComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_launcherId_fkey" FOREIGN KEY ("launcherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_maintainerId_fkey" FOREIGN KEY ("maintainerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_forkOfId_fkey" FOREIGN KEY ("forkOfId") REFERENCES "App"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildJob" ADD CONSTRAINT "BuildJob_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildJob" ADD CONSTRAINT "BuildJob_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildEvent" ADD CONSTRAINT "BuildEvent_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildEvent" ADD CONSTRAINT "BuildEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BuildJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployFile" ADD CONSTRAINT "DeployFile_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeEvent" ADD CONSTRAINT "FeeEvent_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEvent" ADD CONSTRAINT "RevenueEvent_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEvent" ADD CONSTRAINT "RevenueEvent_buybackId_fkey" FOREIGN KEY ("buybackId") REFERENCES "Buyback"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Buyback" ADD CONSTRAINT "Buyback_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditFunding" ADD CONSTRAINT "CreditFunding_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptQueueItem" ADD CONSTRAINT "PromptQueueItem_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptQueueItem" ADD CONSTRAINT "PromptQueueItem_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PromptQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bounty" ADD CONSTRAINT "Bounty_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bounty" ADD CONSTRAINT "Bounty_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bounty" ADD CONSTRAINT "Bounty_claimantId_fkey" FOREIGN KEY ("claimantId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contributor" ADD CONSTRAINT "Contributor_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contributor" ADD CONSTRAINT "Contributor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintainerVote" ADD CONSTRAINT "MaintainerVote_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintainerVote" ADD CONSTRAINT "MaintainerVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HolderBalance" ADD CONSTRAINT "HolderBalance_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppKv" ADD CONSTRAINT "AppKv_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppUserSession" ADD CONSTRAINT "AppUserSession_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppUserSession" ADD CONSTRAINT "AppUserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdImpression" ADD CONSTRAINT "AdImpression_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseFlag" ADD CONSTRAINT "AbuseFlag_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

