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
  curatorNote: z.string().max(1000).optional(),
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
  metadata: z.record(z.any()).optional(),
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
export type RingResponse = z.infer<typeof RingResponseSchema>;
export type RingListResponse = z.infer<typeof RingListResponseSchema>;
export type MemberResponse = z.infer<typeof MemberResponseSchema>;
export type MembersListResponse = z.infer<typeof MembersListResponseSchema>;