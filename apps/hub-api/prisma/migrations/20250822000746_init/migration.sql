-- CreateEnum
CREATE TYPE "RingVisibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "JoinPolicy" AS ENUM ('OPEN', 'APPLICATION', 'INVITATION', 'CLOSED');

-- CreateEnum
CREATE TYPE "PostPolicy" AS ENUM ('OPEN', 'MEMBERS', 'CURATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'REMOVED');

-- CreateEnum
CREATE TYPE "BlockType" AS ENUM ('USER', 'INSTANCE', 'ACTOR');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SERVICE', 'INSTANCE');

-- CreateTable
CREATE TABLE "Ring" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "shortCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "visibility" "RingVisibility" NOT NULL DEFAULT 'PUBLIC',
    "joinPolicy" "JoinPolicy" NOT NULL DEFAULT 'OPEN',
    "postPolicy" "PostPolicy" NOT NULL DEFAULT 'OPEN',
    "ownerDid" TEXT NOT NULL,
    "parentId" TEXT,
    "metadata" JSONB,
    "policies" JSONB,
    "curatorNote" TEXT,

    CONSTRAINT "Ring_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RingRole" (
    "id" TEXT NOT NULL,
    "ringId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RingRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "ringId" TEXT NOT NULL,
    "actorDid" TEXT NOT NULL,
    "roleId" TEXT,
    "status" "MembershipStatus" NOT NULL DEFAULT 'PENDING',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "badgeId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "ringId" TEXT NOT NULL,
    "issuedTo" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "signature" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "imageUrl" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostRef" (
    "id" TEXT NOT NULL,
    "ringId" TEXT NOT NULL,
    "actorDid" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedBy" TEXT NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'PENDING',
    "moderatedAt" TIMESTAMP(3),
    "moderatedBy" TEXT,
    "moderationNote" TEXT,
    "metadata" JSONB,
    "pinned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PostRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL,
    "ringId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "ringId" TEXT NOT NULL,
    "targetDid" TEXT NOT NULL,
    "targetType" "BlockType" NOT NULL,
    "reason" TEXT,
    "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockedBy" TEXT NOT NULL,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "ringId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorDid" TEXT NOT NULL,
    "targetDid" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature" TEXT,
    "publicKey" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HttpSignature" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "actorDid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsed" TIMESTAMP(3),
    "trusted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "HttpSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Actor" (
    "id" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "name" TEXT,
    "type" "ActorType" NOT NULL,
    "instanceUrl" TEXT,
    "publicKey" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "Actor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ring_slug_key" ON "Ring"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Ring_shortCode_key" ON "Ring"("shortCode");

-- CreateIndex
CREATE INDEX "Ring_slug_idx" ON "Ring"("slug");

-- CreateIndex
CREATE INDEX "Ring_ownerDid_idx" ON "Ring"("ownerDid");

-- CreateIndex
CREATE INDEX "Ring_parentId_idx" ON "Ring"("parentId");

-- CreateIndex
CREATE INDEX "Ring_visibility_idx" ON "Ring"("visibility");

-- CreateIndex
CREATE INDEX "Ring_createdAt_idx" ON "Ring"("createdAt");

-- CreateIndex
CREATE INDEX "RingRole_ringId_idx" ON "RingRole"("ringId");

-- CreateIndex
CREATE UNIQUE INDEX "RingRole_ringId_name_key" ON "RingRole"("ringId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_badgeId_key" ON "Membership"("badgeId");

-- CreateIndex
CREATE INDEX "Membership_ringId_idx" ON "Membership"("ringId");

-- CreateIndex
CREATE INDEX "Membership_actorDid_idx" ON "Membership"("actorDid");

-- CreateIndex
CREATE INDEX "Membership_status_idx" ON "Membership"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_ringId_actorDid_key" ON "Membership"("ringId", "actorDid");

-- CreateIndex
CREATE INDEX "Badge_ringId_idx" ON "Badge"("ringId");

-- CreateIndex
CREATE INDEX "Badge_issuedTo_idx" ON "Badge"("issuedTo");

-- CreateIndex
CREATE INDEX "PostRef_ringId_idx" ON "PostRef"("ringId");

-- CreateIndex
CREATE INDEX "PostRef_actorDid_idx" ON "PostRef"("actorDid");

-- CreateIndex
CREATE INDEX "PostRef_status_idx" ON "PostRef"("status");

-- CreateIndex
CREATE INDEX "PostRef_submittedAt_idx" ON "PostRef"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PostRef_ringId_uri_key" ON "PostRef"("ringId", "uri");

-- CreateIndex
CREATE INDEX "Challenge_ringId_idx" ON "Challenge"("ringId");

-- CreateIndex
CREATE INDEX "Challenge_active_idx" ON "Challenge"("active");

-- CreateIndex
CREATE INDEX "Block_ringId_idx" ON "Block"("ringId");

-- CreateIndex
CREATE INDEX "Block_targetDid_idx" ON "Block"("targetDid");

-- CreateIndex
CREATE UNIQUE INDEX "Block_ringId_targetDid_key" ON "Block"("ringId", "targetDid");

-- CreateIndex
CREATE INDEX "AuditLog_ringId_idx" ON "AuditLog"("ringId");

-- CreateIndex
CREATE INDEX "AuditLog_actorDid_idx" ON "AuditLog"("actorDid");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "HttpSignature_keyId_key" ON "HttpSignature"("keyId");

-- CreateIndex
CREATE INDEX "HttpSignature_actorDid_idx" ON "HttpSignature"("actorDid");

-- CreateIndex
CREATE INDEX "HttpSignature_trusted_idx" ON "HttpSignature"("trusted");

-- CreateIndex
CREATE UNIQUE INDEX "Actor_did_key" ON "Actor"("did");

-- CreateIndex
CREATE INDEX "Actor_type_idx" ON "Actor"("type");

-- CreateIndex
CREATE INDEX "Actor_verified_idx" ON "Actor"("verified");

-- CreateIndex
CREATE INDEX "Actor_trusted_idx" ON "Actor"("trusted");

-- AddForeignKey
ALTER TABLE "Ring" ADD CONSTRAINT "Ring_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Ring"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RingRole" ADD CONSTRAINT "RingRole_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "RingRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Badge" ADD CONSTRAINT "Badge_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostRef" ADD CONSTRAINT "PostRef_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_ringId_fkey" FOREIGN KEY ("ringId") REFERENCES "Ring"("id") ON DELETE CASCADE ON UPDATE CASCADE;
