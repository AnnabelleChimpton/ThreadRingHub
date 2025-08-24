-- Add member role to all rings that don't have one
-- This fixes rings created via forking that were missing the member role

INSERT INTO "RingRole" (id, "ringId", name, permissions, "createdAt")
SELECT 
  gen_random_uuid(),
  r.id,
  'member',
  '["submit_posts", "view_content"]'::json,
  NOW()
FROM "Ring" r 
WHERE NOT EXISTS (
  SELECT 1 FROM "RingRole" rr 
  WHERE rr."ringId" = r.id AND rr.name = 'member'
);

-- Show how many rings were updated
SELECT COUNT(*) as "Rings fixed" 
FROM "Ring" r 
WHERE EXISTS (
  SELECT 1 FROM "RingRole" rr 
  WHERE rr."ringId" = r.id AND rr.name = 'member'
);