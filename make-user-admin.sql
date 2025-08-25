-- Make a user admin (bypasses all rate limits)
-- Replace 'user-did-here' with the actual DID of the user

UPDATE "Actor" 
SET "isAdmin" = true 
WHERE "did" = 'user-did-here';

-- Verify the change
SELECT "did", "name", "isAdmin", "trusted", "verified" 
FROM "Actor" 
WHERE "did" = 'user-did-here';

-- To remove admin status:
-- UPDATE "Actor" SET "isAdmin" = false WHERE "did" = 'user-did-here';