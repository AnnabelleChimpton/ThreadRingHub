import { z } from 'zod';

// Ring visibility options
export const RingVisibilitySchema = z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']);

// Join policy options
export const JoinPolicySchema = z.enum(['OPEN', 'APPLICATION', 'INVITATION', 'CLOSED']);

// Post policy options
export const PostPolicySchema = z.enum(['OPEN', 'MEMBERS', 'CURATED', 'CLOSED']);

// Ring creation schema
export const CreateRingSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  shortCode: z.string().min(2).max(10).regex(/^[a-zA-Z0-9-]+$/).optional(),
  visibility: RingVisibilitySchema.default('PUBLIC'),
  joinPolicy: JoinPolicySchema.default('OPEN'),
  postPolicy: PostPolicySchema.default('OPEN'),
  parentSlug: z.string().optional(), // For creating forks
  curatorNote: z.string().max(1000).optional(),
  badgeImageUrl: z.string().url().optional(), // 88x31 badge image URL
  badgeImageHighResUrl: z.string().url().optional(), // 352x124 high-res badge image URL
  metadata: z.record(z.any()).optional(),
  policies: z.record(z.any()).optional(),
});

// Ring update schema
export const UpdateRingSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  shortCode: z.string().min(2).max(10).regex(/^[a-zA-Z0-9-]+$/).optional(),
  visibility: RingVisibilitySchema.optional(),
  joinPolicy: JoinPolicySchema.optional(),
  postPolicy: PostPolicySchema.optional(),
  parentSlug: z.string().optional(), // For updating parent threadring
  curatorNote: z.string().max(1000).optional(),
  badgeImageUrl: z.string().url().optional(), // 88x31 badge image URL
  badgeImageHighResUrl: z.string().url().optional(), // 352x124 high-res badge image URL
  metadata: z.record(z.any()).optional(),
  policies: z.record(z.any()).optional(),
});

// Ring query parameters
export const RingQuerySchema = z.object({
  search: z.string().optional(),
  visibility: RingVisibilitySchema.optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  sort: z.enum(['created', 'updated', 'name', 'members']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// Ring member query parameters
export const MemberQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED']).optional(),
  role: z.string().optional(),
});

// Trending query parameters
export const TrendingQuerySchema = z.object({
  timeWindow: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  limit: z.coerce.number().min(1).max(50).default(10),
});

// Fork creation schema
export const ForkRingSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  shortCode: z.string().min(2).max(10).regex(/^[a-zA-Z0-9-]+$/).optional(),
  visibility: RingVisibilitySchema.default('PUBLIC'),
  joinPolicy: JoinPolicySchema.default('OPEN'),
  postPolicy: PostPolicySchema.default('OPEN'),
  curatorNote: z.string().max(1000).optional(),
  badgeImageUrl: z.string().url().optional(), // 88x31 badge image URL
  badgeImageHighResUrl: z.string().url().optional(), // 352x124 high-res badge image URL
  metadata: z.record(z.any()).optional(),
});

// Join ring schema
export const JoinRingSchema = z.object({
  ringSlug: z.string(),
  message: z.string().max(500).optional(), // Application message for APPLICATION policy
  metadata: z.record(z.any()).optional(),
});

// Update member role schema
export const UpdateMemberRoleSchema = z.object({
  role: z.string(),
  metadata: z.record(z.any()).optional(),
});

// Badge schema
export const BadgeSchema = z.object({
  id: z.string(),
  ringSlug: z.string(),
  actorDid: z.string(),
  issueDate: z.string(),
  expiryDate: z.string().nullable(),
  signature: z.string(), // Cryptographic signature
  metadata: z.record(z.any()).optional(),
});

// Badge response
export const BadgeResponseSchema = z.object({
  badge: BadgeSchema,
  verification: z.object({
    isValid: z.boolean(),
    verifiedAt: z.string(),
    issuer: z.string(),
  }),
});

// Submit post schema
export const SubmitPostSchema = z.object({
  ringSlug: z.string(),
  uri: z.string().url(),
  digest: z.string(), // Content hash/digest
  actorDid: z.string().optional(), // If submitting on behalf of someone else
  metadata: z.record(z.any()).optional(),
});

// Curate post schema
export const CuratePostSchema = z.object({
  action: z.enum(['accept', 'reject', 'pin', 'unpin', 'remove']),
  reason: z.string().max(500).optional(),
  metadata: z.record(z.any()).optional(),
});

// Post query schema
export const PostQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'REMOVED']).optional(),
  actorDid: z.string().optional(),
  since: z.string().optional(), // ISO date string
  until: z.string().optional(), // ISO date string
  pinned: z.coerce.boolean().optional(),
  scope: z.enum(['ring', 'parent', 'children', 'siblings', 'family']).default('ring'),
});

// Audit query schema
export const AuditQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  action: z.string().optional(),
  actorDid: z.string().optional(),
  since: z.string().optional(), // ISO date string
  until: z.string().optional(), // ISO date string
});

// Post response schema
export const PostResponseSchema = z.object({
  id: z.string(),
  ringSlug: z.string(),
  uri: z.string(),
  digest: z.string(),
  actorDid: z.string(),
  submittedAt: z.string(),
  submittedBy: z.string(),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'REMOVED']),
  moderatedAt: z.string().nullable(),
  moderatedBy: z.string().nullable(),
  moderationNote: z.string().nullable(),
  pinned: z.boolean(),
  metadata: z.record(z.any()).nullable(),
});

// Posts list response
export const PostsListResponseSchema = z.object({
  posts: z.array(PostResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

// Audit entry response
export const AuditEntryResponseSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorDid: z.string(),
  targetDid: z.string().nullable(),
  timestamp: z.string(),
  metadata: z.record(z.any()).nullable(),
});

// Audit list response
export const AuditListResponseSchema = z.object({
  entries: z.array(AuditEntryResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

// Ring response schema
export const RingResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  shortCode: z.string().nullable(),
  visibility: RingVisibilitySchema,
  joinPolicy: JoinPolicySchema,
  postPolicy: PostPolicySchema,
  ownerDid: z.string(),
  parentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  curatorNote: z.string().nullable(),
  badgeImageUrl: z.string().nullable(),
  badgeImageHighResUrl: z.string().nullable(),
  metadata: z.record(z.any()).nullable(),
  policies: z.record(z.any()).nullable(),
  // Computed fields
  memberCount: z.number().optional(),
  postCount: z.number().optional(),
  lineage: z.array(z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  })).optional(),
  children: z.array(z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    memberCount: z.number(),
  })).optional(),
  // Current user's membership info (only included if authenticated)
  currentUserMembership: z.object({
    status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED']),
    role: z.string().nullable(),
    joinedAt: z.string().nullable(),
    badgeId: z.string().nullable(),
  }).optional(),
});

// Ring list response schema
export const RingListResponseSchema = z.object({
  rings: z.array(RingResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

// Member response schema
export const MemberResponseSchema = z.object({
  actorDid: z.string(),
  actorName: z.string().nullable(),
  avatarUrl: z.string().nullable(),           // From DID document (Tier 2 - optional)
  profileUrl: z.string().nullable(),          // From DID service endpoint (Tier 1 - always present for federated users)
  instanceDomain: z.string().nullable(),      // Parsed from DID for federation UX
  handles: z.array(z.object({                 // Handles array for federation UX (e.g., [{handle: "annabelle", domain: "homepageagain.com", url: "https://..."}])
    handle: z.string(),
    domain: z.string(),
    url: z.string(),
  })),
  status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED']),
  role: z.string().nullable(),
  joinedAt: z.string(),
  badgeId: z.string().nullable(),
});

// Members list response schema
export const MembersListResponseSchema = z.object({
  members: z.array(MemberResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export type CreateRingInput = z.infer<typeof CreateRingSchema>;
export type UpdateRingInput = z.infer<typeof UpdateRingSchema>;
export type RingQueryInput = z.infer<typeof RingQuerySchema>;
export type MemberQueryInput = z.infer<typeof MemberQuerySchema>;
export type TrendingQueryInput = z.infer<typeof TrendingQuerySchema>;
export type ForkRingInput = z.infer<typeof ForkRingSchema>;
export type JoinRingInput = z.infer<typeof JoinRingSchema>;
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;
export type BadgeInput = z.infer<typeof BadgeSchema>;
export type BadgeResponse = z.infer<typeof BadgeResponseSchema>;
export type SubmitPostInput = z.infer<typeof SubmitPostSchema>;
export type CuratePostInput = z.infer<typeof CuratePostSchema>;
export type PostQueryInput = z.infer<typeof PostQuerySchema>;
export type AuditQueryInput = z.infer<typeof AuditQuerySchema>;
export type PostResponse = z.infer<typeof PostResponseSchema>;
export type PostsListResponse = z.infer<typeof PostsListResponseSchema>;
export type AuditEntryResponse = z.infer<typeof AuditEntryResponseSchema>;
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;
export type RingResponse = z.infer<typeof RingResponseSchema>;
export type RingListResponse = z.infer<typeof RingListResponseSchema>;
export type MemberResponse = z.infer<typeof MemberResponseSchema>;
export type MembersListResponse = z.infer<typeof MembersListResponseSchema>;