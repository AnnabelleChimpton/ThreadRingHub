-- ThreadRingHub Admin Utilities
-- Run these commands directly on your production database

-- ========================================
-- USER LOOKUP QUERIES
-- ========================================

-- Find user by name (case-insensitive partial match)
SELECT "did", "name", "type", "verified", "trusted", "isAdmin", "discoveredAt"
FROM "Actor" 
WHERE "name" ILIKE '%username-here%' 
    AND "type" = 'USER'
ORDER BY "name";

-- Find user by partial DID
SELECT "did", "name", "type", "verified", "trusted", "isAdmin"
FROM "Actor" 
WHERE "did" ILIKE '%partial-did-here%'
ORDER BY "discoveredAt" DESC;

-- List all users (most recent first)
SELECT "did", "name", "verified", "trusted", "isAdmin", "discoveredAt"
FROM "Actor" 
WHERE "type" = 'USER'
ORDER BY "discoveredAt" DESC
LIMIT 20;

-- Find users by ring ownership (if you know a ring they created)
SELECT DISTINCT a."did", a."name", r."name" as "ringName", r."slug"
FROM "Actor" a
INNER JOIN "Ring" r ON a."did" = r."ownerDid"
WHERE r."name" ILIKE '%ring-name%' OR r."slug" ILIKE '%ring-slug%'
ORDER BY r."createdAt" DESC;

-- ========================================
-- ADMIN MANAGEMENT
-- ========================================

-- 1. Make a user admin (bypasses all rate limits)
-- Replace 'user-did-here' with the actual DID
UPDATE "Actor" 
SET "isAdmin" = true 
WHERE "did" = 'user-did-here';

-- 2. Remove admin status from a user
-- UPDATE "Actor" SET "isAdmin" = false WHERE "did" = 'user-did-here';

-- 3. Clear all rate limit violations for a user
DELETE FROM "RateLimit" WHERE "actorDid" = 'user-did-here';
UPDATE "ActorReputation" 
SET "flaggedForReview" = false, 
    "violationCount" = 0, 
    "lastViolationAt" = null, 
    "cooldownUntil" = null 
WHERE "actorDid" = 'user-did-here';

-- 4. View users flagged for review
SELECT 
    ar."actorDid",
    a."name" as "actorName",
    ar."tier",
    ar."violationCount",
    ar."lastViolationAt",
    ar."cooldownUntil",
    ar."ringsCreated",
    ar."activeRings"
FROM "ActorReputation" ar
LEFT JOIN "Actor" a ON ar."actorDid" = a."did"
WHERE ar."flaggedForReview" = true
ORDER BY ar."lastCalculatedAt" DESC;

-- 5. View recent fork activity for a user
SELECT 
    rl."performedAt",
    rl."metadata"->>'ringId' as "ringId",
    r."name" as "ringName",
    r."slug" as "ringSlug"
FROM "RateLimit" rl
LEFT JOIN "Ring" r ON (rl."metadata"->>'ringId')::uuid = r."id"
WHERE rl."actorDid" = 'user-did-here' 
    AND rl."action" = 'fork_ring'
ORDER BY rl."performedAt" DESC
LIMIT 20;

-- 6. Apply manual cooldown to a user (24 hours)
INSERT INTO "ActorReputation" ("id", "actorDid", "tier", "violationCount", "lastViolationAt", "cooldownUntil")
VALUES (
    gen_random_uuid(),
    'user-did-here',
    'NEW',
    1,
    NOW(),
    NOW() + INTERVAL '24 hours'
)
ON CONFLICT ("actorDid") 
DO UPDATE SET
    "violationCount" = "ActorReputation"."violationCount" + 1,
    "lastViolationAt" = NOW(),
    "cooldownUntil" = NOW() + INTERVAL '24 hours';

-- 7. Get user statistics
SELECT 
    a."did",
    a."name",
    a."isAdmin",
    a."verified",
    a."trusted",
    a."discoveredAt",
    ar."tier",
    ar."reputationScore",
    ar."ringsCreated",
    ar."activeRings",
    ar."totalPosts",
    ar."membershipCount",
    ar."flaggedForReview",
    ar."violationCount",
    ar."cooldownUntil"
FROM "Actor" a
LEFT JOIN "ActorReputation" ar ON a."did" = ar."actorDid"
WHERE a."did" = 'user-did-here';

-- 8. Clean up old rate limit records (older than 7 days)
DELETE FROM "RateLimit" 
WHERE "performedAt" < NOW() - INTERVAL '7 days';

-- 9. View current rate limit status for all users (top fork creators)
SELECT 
    rl."actorDid",
    a."name",
    COUNT(*) as "forksThisWeek",
    MAX(rl."performedAt") as "lastFork"
FROM "RateLimit" rl
LEFT JOIN "Actor" a ON rl."actorDid" = a."did"
WHERE rl."action" = 'fork_ring' 
    AND rl."performedAt" > NOW() - INTERVAL '7 days'
GROUP BY rl."actorDid", a."name"
ORDER BY "forksThisWeek" DESC
LIMIT 20;

-- 10. Emergency disable all rate limits (temporary - restart required to re-enable)
-- UPDATE "Actor" SET "isAdmin" = true WHERE "verified" = true;
-- WARNING: This makes ALL verified users admins - use carefully!