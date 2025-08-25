-- CreateEnum
CREATE TYPE "UserTier" AS ENUM ('NEW', 'ESTABLISHED', 'VETERAN', 'TRUSTED');

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "actorDid" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowType" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActorReputation" (
    "id" TEXT NOT NULL,
    "actorDid" TEXT NOT NULL,
    "tier" "UserTier" NOT NULL DEFAULT 'NEW',
    "reputationScore" INTEGER NOT NULL DEFAULT 0,
    "ringsCreated" INTEGER NOT NULL DEFAULT 0,
    "activeRings" INTEGER NOT NULL DEFAULT 0,
    "totalPosts" INTEGER NOT NULL DEFAULT 0,
    "membershipCount" INTEGER NOT NULL DEFAULT 0,
    "flaggedForReview" BOOLEAN NOT NULL DEFAULT false,
    "violationCount" INTEGER NOT NULL DEFAULT 0,
    "lastViolationAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "lastCalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActorReputation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimit_actorDid_action_performedAt_idx" ON "RateLimit"("actorDid", "action", "performedAt");

-- CreateIndex
CREATE INDEX "RateLimit_actorDid_action_windowType_performedAt_idx" ON "RateLimit"("actorDid", "action", "windowType", "performedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActorReputation_actorDid_key" ON "ActorReputation"("actorDid");

-- CreateIndex
CREATE INDEX "ActorReputation_tier_idx" ON "ActorReputation"("tier");

-- CreateIndex
CREATE INDEX "ActorReputation_reputationScore_idx" ON "ActorReputation"("reputationScore");

-- CreateIndex
CREATE INDEX "ActorReputation_flaggedForReview_idx" ON "ActorReputation"("flaggedForReview");

-- CreateIndex
CREATE INDEX "ActorReputation_cooldownUntil_idx" ON "ActorReputation"("cooldownUntil");