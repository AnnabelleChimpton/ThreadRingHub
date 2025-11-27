import { FastifyInstance } from 'fastify';
import { prisma } from '../database/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import {
    authenticateActor,
    requireVerifiedActor,
    requireNotBlocked,
    requireMembership,
    requirePermission,
    auditLogger
} from '../security/middleware';
import { rateLimit, recordRateLimitUsage } from '../middleware/rate-limit';
import {
    type CreateRingInput,
    type UpdateRingInput,
    type RingQueryInput,
    type MemberQueryInput,
    type TrendingQueryInput,
    type ForkRingInput,
    type RingResponse,
    type RingListResponse,
    type MembersListResponse,
} from '../schemas/ring-schemas';
import { config } from '../config';
import { generateBadge } from '../utils/badge';
import crypto from 'crypto';

/**
 * Generate a unique slug from ring name
 */
function generateSlug(name: string, existingSlugs: string[] = []): string {
    let baseSlug = name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
        .substring(0, 25) // Limit to 25 characters
        .replace(/-+$/, '') // Remove trailing hyphens after truncation
        .trim();

    if (baseSlug.length === 0) {
        baseSlug = 'ring';
    } else if (baseSlug.length < 3) {
        // Ensure minimum 3 characters
        baseSlug = baseSlug.padEnd(3, '1');
    }

    // Ensure uniqueness
    let slug = baseSlug;
    let counter = 1;
    while (existingSlugs.includes(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter++;
    }

    return slug;
}

/**
 * Build ring response with computed fields
 */
async function buildRingResponse(
    ring: any,
    includeLineage = false,
    includeChildren = false,
    actorDid?: string
): Promise<RingResponse> {
    const response: RingResponse = {
        id: ring.id,
        slug: ring.slug,
        name: ring.name,
        description: ring.description,
        shortCode: ring.shortCode,
        visibility: ring.visibility,
        joinPolicy: ring.joinPolicy,
        postPolicy: ring.postPolicy,
        ownerDid: ring.ownerDid,
        parentId: ring.parentId,
        createdAt: ring.createdAt.toISOString(),
        updatedAt: ring.updatedAt.toISOString(),
        curatorNote: ring.curatorNote,
        bannerUrl: ring.bannerUrl,
        themeColor: ring.themeColor,
        badgeImageUrl: ring.badgeImageUrl,
        badgeImageHighResUrl: ring.badgeImageHighResUrl,
        metadata: ring.metadata,
        policies: ring.policies,
    };

    // Add member count
    const memberCount = await prisma.membership.count({
        where: {
            ringId: ring.id,
            status: 'ACTIVE',
        },
    });
    response.memberCount = memberCount;

    // Add post count
    const postCount = await prisma.postRef.count({
        where: {
            ringId: ring.id,
            status: 'ACCEPTED',
        },
    });
    response.postCount = postCount;

    // Add lineage (ancestors)
    if (includeLineage && ring.parentId) {
        const lineage = [];
        let currentRing = ring;

        while (currentRing.parentId) {
            const parent = await prisma.ring.findUnique({
                where: { id: currentRing.parentId },
                select: { id: true, slug: true, name: true, parentId: true },
            });

            if (!parent) break;

            lineage.unshift({
                id: parent.id,
                slug: parent.slug,
                name: parent.name,
            });

            currentRing = parent;
        }

        response.lineage = lineage;
    }

    // Add children
    if (includeChildren) {
        const children = await prisma.ring.findMany({
            where: { parentId: ring.id },
            select: { id: true, slug: true, name: true },
        });

        response.children = await Promise.all(
            children.map(async (child) => {
                const childMemberCount = await prisma.membership.count({
                    where: {
                        ringId: child.id,
                        status: 'ACTIVE',
                    },
                });

                return {
                    id: child.id,
                    slug: child.slug,
                    name: child.name,
                    memberCount: childMemberCount,
                };
            })
        );
    }

    // Add current user's membership info if actor is provided
    if (actorDid) {
        const membership = await prisma.membership.findFirst({
            where: {
                ringId: ring.id,
                actorDid: actorDid,
            },
            include: {
                role: { select: { name: true } },
            },
        });

        if (membership) {
            response.currentUserMembership = {
                status: membership.status,
                role: membership.role?.name || null,
                joinedAt: membership.joinedAt?.toISOString() || null,
                badgeId: membership.badgeId,
            };
        }
    }

    return response;
}

export async function ringsRoutes(fastify: FastifyInstance) {
    // Add security middleware to all protected routes
    fastify.addHook('preHandler', auditLogger);

    /**
     * GET /trp/stats - Get network statistics
     */
    fastify.get('/stats', {
        schema: {
            tags: ['rings'],
            summary: 'Get network statistics',
            description: 'Returns total counts of rings, actors, and other network metrics',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        totalRings: { type: 'number' },
                        publicRings: { type: 'number' },
                        privateRings: { type: 'number' },
                        unlistedRings: { type: 'number' },
                        totalActors: { type: 'number' },
                        verifiedActors: { type: 'number' },
                        totalMemberships: { type: 'number' },
                        activeMemberships: { type: 'number' },
                        totalPosts: { type: 'number' },
                        acceptedPosts: { type: 'number' },
                    },
                },
            },
        },
    }, async (_request, reply) => {
        try {
            // Run all counts in parallel for efficiency
            const [
                totalRings,
                publicRings,
                privateRings,
                unlistedRings,
                totalActors,
                verifiedActors,
                totalMemberships,
                activeMemberships,
                totalPosts,
                acceptedPosts,
            ] = await Promise.all([
                prisma.ring.count(),
                prisma.ring.count({ where: { visibility: 'PUBLIC' } }),
                prisma.ring.count({ where: { visibility: 'PRIVATE' } }),
                prisma.ring.count({ where: { visibility: 'UNLISTED' } }),
                prisma.actor.count(),
                prisma.actor.count({ where: { verified: true } }),
                prisma.membership.count(),
                prisma.membership.count({ where: { status: 'ACTIVE' } }),
                prisma.postRef.count(),
                prisma.postRef.count({ where: { status: 'ACCEPTED' } }),
            ]);

            reply.send({
                totalRings,
                publicRings,
                privateRings,
                unlistedRings,
                totalActors,
                verifiedActors,
                totalMemberships,
                activeMemberships,
                totalPosts,
                acceptedPosts,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get network statistics');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve network statistics',
            });
        }
    });

    /**
     * GET /trp/root - Get the root ThreadRing (efficient redirect to spool)
     */
    fastify.get('/root', {
        schema: {
            tags: ['rings'],
            summary: 'Get root ThreadRing',
        },
    }, async (request, reply) => {
        try {
            // Efficient: Just redirect to the known root slug instead of querying database
            const rootSlug = config.rings.rootSlug;

            const ring = await prisma.ring.findUnique({
                where: { slug: rootSlug },
            });

            if (!ring) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Root ring not found',
                });
                return;
            }

            const response = await buildRingResponse(ring, true, true, request.actor?.did);
            reply.send(response);
        } catch (error) {
            logger.error({ error }, 'Failed to get root ring');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve root ring',
            });
        }
    });

    /**
     * GET /trp/my/memberships - Get current user's ring memberships
     */
    fastify.get<{ Querystring: { status?: string; limit?: number; offset?: number } }>('/my/memberships', {
        preHandler: [authenticateActor],
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED'] },
                    limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
                    offset: { type: 'number', minimum: 0, default: 0 },
                },
            },
            tags: ['memberships'],
            summary: 'Get current user\'s ring memberships',
            security: [{ httpSignature: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        memberships: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    ringSlug: { type: 'string' },
                                    ringName: { type: 'string' },
                                    ringDescription: { type: 'string' },
                                    ringVisibility: { type: 'string' },
                                    status: { type: 'string' },
                                    role: { type: 'string' },
                                    joinedAt: { type: 'string' },
                                    badgeId: { type: 'string' },
                                },
                            },
                        },
                        total: { type: 'number' },
                        limit: { type: 'number' },
                        offset: { type: 'number' },
                        hasMore: { type: 'boolean' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            if (!request.actor) {
                reply.code(401).send({
                    error: 'Authentication required',
                    message: 'Must be authenticated to view memberships',
                });
                return;
            }

            const { status, limit = 20, offset = 0 } = request.query;
            const actorDid = request.actor.did;

            const where: any = { actorDid };
            // Default to ACTIVE memberships unless specified
            where.status = status || 'ACTIVE';

            const [memberships, total] = await Promise.all([
                prisma.membership.findMany({
                    where,
                    include: {
                        ring: {
                            select: {
                                slug: true,
                                name: true,
                                description: true,
                                visibility: true,
                            },
                        },
                        role: { select: { name: true } },
                    },
                    take: limit,
                    skip: offset,
                    orderBy: { joinedAt: 'desc' },
                }),
                prisma.membership.count({ where }),
            ]);

            const userMemberships = memberships.map(m => ({
                ringSlug: m.ring.slug,
                ringName: m.ring.name,
                ringDescription: m.ring.description,
                ringVisibility: m.ring.visibility,
                status: m.status,
                role: m.role?.name || null,
                joinedAt: m.joinedAt?.toISOString() || null,
                badgeId: m.badgeId,
            }));

            reply.send({
                memberships: userMemberships,
                total,
                limit,
                offset,
                hasMore: offset + limit < total,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get user memberships');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve memberships',
            });
        }
    });

    /**
     * GET /trp/my/feed - Get unified feed from all rings user is member of
     */
    fastify.get<{
        Querystring: {
            limit?: number;
            offset?: number;
            since?: string;
            until?: string;
            includeNotifications?: boolean;
            ringId?: string;
            sort?: 'newest' | 'oldest';
        }
    }>('/my/feed', {
        preHandler: [authenticateActor],
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
                    offset: { type: 'number', minimum: 0, default: 0 },
                    since: { type: 'string', format: 'date-time' },
                    until: { type: 'string', format: 'date-time' },
                    includeNotifications: { type: 'boolean', default: true },
                    ringId: { type: 'string' },
                    sort: { type: 'string', enum: ['newest', 'oldest'], default: 'newest' }
                },
            },
            tags: ['feeds'],
            summary: 'Get unified feed from all rings user is member of',
            security: [{ httpSignature: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        posts: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    ringId: { type: 'string' },
                                    ringSlug: { type: 'string' },
                                    ringName: { type: 'string' },
                                    actorDid: { type: 'string' },
                                    actorName: { type: 'string', nullable: true },
                                    uri: { type: 'string' },
                                    digest: { type: 'string' },
                                    submittedAt: { type: 'string' },
                                    submittedBy: { type: 'string' },
                                    status: { type: 'string' },
                                    metadata: { type: 'object', nullable: true },
                                    pinned: { type: 'boolean' },
                                    isNotification: { type: 'boolean' },
                                    notificationType: { type: 'string', nullable: true },
                                },
                            },
                        },
                        pagination: {
                            type: 'object',
                            properties: {
                                total: { type: 'number' },
                                limit: { type: 'number' },
                                offset: { type: 'number' },
                                hasMore: { type: 'boolean' },
                            },
                        },
                        generatedAt: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            if (!request.actor) {
                reply.code(401).send({
                    error: 'Authentication required',
                    message: 'Must be authenticated to view your feed',
                });
                return;
            }

            const actorDid = request.actor.did;
            const {
                limit = 20,
                offset = 0,
                since,
                until,
                includeNotifications = true,
                ringId,
                sort = 'newest'
            } = request.query;

            // Get all active memberships for the user
            const memberships = await prisma.membership.findMany({
                where: {
                    actorDid,
                    status: 'ACTIVE'
                },
                select: { ringId: true }
            });

            const memberRingIds = memberships.map(m => m.ringId);

            if (memberRingIds.length === 0) {
                // User is not a member of any rings
                reply.send({
                    posts: [],
                    pagination: {
                        total: 0,
                        limit,
                        offset,
                        hasMore: false
                    },
                    generatedAt: new Date().toISOString()
                });
                return;
            }

            // Build where clause
            const where: any = {
                ringId: { in: memberRingIds },
                status: 'ACCEPTED'
            };

            // Filter by specific ring if provided
            if (ringId && memberRingIds.includes(ringId)) {
                where.ringId = ringId;
            }

            // Date filters
            if (since) {
                where.submittedAt = { ...where.submittedAt, gte: new Date(since) };
            }
            if (until) {
                where.submittedAt = { ...where.submittedAt, lte: new Date(until) };
            }

            // Exclude notifications if requested
            if (!includeNotifications) {
                where.OR = [
                    { metadata: { equals: Prisma.JsonNull } },
                    {
                        metadata: {
                            path: ['type'],
                            not: 'fork_notification'
                        }
                    }
                ];
            }

            // Get posts with ring info
            const [posts, total] = await Promise.all([
                prisma.postRef.findMany({
                    where,
                    include: {
                        ring: {
                            select: {
                                slug: true,
                                name: true
                            }
                        }
                    },
                    take: limit,
                    skip: offset,
                    orderBy: {
                        submittedAt: sort === 'newest' ? 'desc' : 'asc'
                    }
                }),
                prisma.postRef.count({ where })
            ]);

            // Get actor names
            const actorDids = [...new Set(posts.map(p => p.actorDid))];
            const actors = await prisma.actor.findMany({
                where: { did: { in: actorDids } },
                select: { did: true, name: true }
            });

            const actorNameMap = new Map(actors.map(a => [a.did, a.name]));

            // Format response
            const formattedPosts = posts.map(post => {
                const metadata = post.metadata as any;
                return {
                    id: post.id,
                    ringId: post.ringId,
                    ringSlug: post.ring.slug,
                    ringName: post.ring.name,
                    actorDid: post.actorDid,
                    actorName: actorNameMap.get(post.actorDid) || null,
                    uri: post.uri,
                    digest: post.digest,
                    submittedAt: post.submittedAt.toISOString(),
                    submittedBy: post.submittedBy,
                    status: post.status,
                    metadata: post.metadata,
                    pinned: post.pinned,
                    isNotification: metadata?.type === 'fork_notification',
                    notificationType: metadata?.type || null
                };
            });

            reply.send({
                posts: formattedPosts,
                pagination: {
                    total,
                    limit,
                    offset,
                    hasMore: offset + limit < total
                },
                generatedAt: new Date().toISOString()
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get user feed');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve feed',
            });
        }
    });

    /**
     * GET /trp/trending/feed - Get trending posts across all public rings
     */
    fastify.get<{
        Querystring: {
            limit?: number;
            timeWindow?: 'hour' | 'day' | 'week';
            includeNotifications?: boolean;
        }
    }>('/trending/feed', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', minimum: 1, maximum: 50, default: 20 },
                    timeWindow: { type: 'string', enum: ['hour', 'day', 'week'], default: 'day' },
                    includeNotifications: { type: 'boolean', default: true },
                },
            },
            tags: ['feeds'],
            summary: 'Get trending posts across all public rings',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        posts: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    ringId: { type: 'string' },
                                    ringSlug: { type: 'string' },
                                    ringName: { type: 'string' },
                                    actorDid: { type: 'string' },
                                    actorName: { type: 'string', nullable: true },
                                    uri: { type: 'string' },
                                    digest: { type: 'string' },
                                    submittedAt: { type: 'string' },
                                    submittedBy: { type: 'string' },
                                    status: { type: 'string' },
                                    metadata: { type: 'object', nullable: true },
                                    pinned: { type: 'boolean' },
                                    isNotification: { type: 'boolean' },
                                    notificationType: { type: 'string', nullable: true },
                                },
                            },
                        },
                        timeWindow: { type: 'string' },
                        generatedAt: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const {
                limit = 20,
                timeWindow = 'day',
                includeNotifications = true
            } = request.query;

            // Calculate time cutoff
            const now = new Date();
            const cutoff = new Date();
            switch (timeWindow) {
                case 'hour':
                    cutoff.setHours(now.getHours() - 1);
                    break;
                case 'day':
                    cutoff.setDate(now.getDate() - 1);
                    break;
                case 'week':
                    cutoff.setDate(now.getDate() - 7);
                    break;
            }

            // Build where clause - only public rings
            const where: any = {
                status: 'ACCEPTED',
                submittedAt: { gte: cutoff },
                ring: {
                    visibility: 'PUBLIC'
                }
            };

            // Exclude notifications if requested
            if (!includeNotifications) {
                where.OR = [
                    { metadata: { equals: Prisma.JsonNull } },
                    {
                        metadata: {
                            path: ['type'],
                            not: 'fork_notification'
                        }
                    }
                ];
            }

            // Get trending posts (for now, just recent posts from public rings)
            // In production, you might want to add engagement metrics
            const posts = await prisma.postRef.findMany({
                where,
                include: {
                    ring: {
                        select: {
                            slug: true,
                            name: true
                        }
                    }
                },
                take: limit,
                orderBy: {
                    submittedAt: 'desc'
                }
            });

            // Get actor names
            const actorDids = [...new Set(posts.map(p => p.actorDid))];
            const actors = await prisma.actor.findMany({
                where: { did: { in: actorDids } },
                select: { did: true, name: true }
            });

            const actorNameMap = new Map(actors.map(a => [a.did, a.name]));

            // Format response
            const formattedPosts = posts.map(post => {
                const metadata = post.metadata as any;
                return {
                    id: post.id,
                    ringId: post.ringId,
                    ringSlug: post.ring.slug,
                    ringName: post.ring.name,
                    actorDid: post.actorDid,
                    actorName: actorNameMap.get(post.actorDid) || null,
                    uri: post.uri,
                    digest: post.digest,
                    submittedAt: post.submittedAt.toISOString(),
                    submittedBy: post.submittedBy,
                    status: post.status,
                    metadata: post.metadata,
                    pinned: post.pinned,
                    isNotification: metadata?.type === 'fork_notification',
                    notificationType: metadata?.type || null
                };
            });

            reply.send({
                posts: formattedPosts,
                timeWindow,
                generatedAt: new Date().toISOString()
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get trending feed');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve trending feed',
            });
        }
    });

    /**
     * GET /trp/rings - List and search rings
     */
    fastify.get<{ Querystring: RingQueryInput }>('/rings', {
        preHandler: [authenticateActor],
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    search: { type: 'string' },
                    visibility: { type: 'string', enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'] },
                    limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
                    offset: { type: 'number', minimum: 0, default: 0 },
                    sort: { type: 'string', enum: ['created', 'updated', 'name', 'members'], default: 'created' },
                    order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
                },
            },
            tags: ['rings'],
            summary: 'List and search rings',
            description: 'Lists rings with optional search and filtering. If authenticated, includes current user membership status and role for each ring.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        rings: { type: 'array' },
                        total: { type: 'number' },
                        limit: { type: 'number' },
                        offset: { type: 'number' },
                        hasMore: { type: 'boolean' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { search, visibility, limit, offset, sort, order, memberDid } = request.query;

            const where: any = {};

            // Search functionality
            if (search) {
                where.OR = [
                    { name: { contains: search, mode: 'insensitive' } },
                    { description: { contains: search, mode: 'insensitive' } },
                    { shortCode: { contains: search, mode: 'insensitive' } },
                ];
            }

            // Only show public rings to unauthenticated users
            // If viewing someone else's rings, also restrict to PUBLIC
            if (!request.actor || (memberDid && request.actor.did !== memberDid)) {
                where.visibility = 'PUBLIC';
            } else if (visibility) {
                where.visibility = visibility;
            }

            // Filter by membership if requested
            if (memberDid) {
                where.memberships = {
                    some: {
                        actorDid: memberDid,
                        status: 'ACTIVE'
                    }
                };
            }

            // Build order clause
            const orderBy: any = {};
            switch (sort) {
                case 'name':
                    orderBy.name = order;
                    break;
                case 'updated':
                    orderBy.updatedAt = order;
                    break;
                case 'members':
                    // This would require a more complex query in production
                    orderBy.createdAt = order;
                    break;
                default:
                    orderBy.createdAt = order;
            }

            const [rings, total] = await Promise.all([
                prisma.ring.findMany({
                    where,
                    take: limit,
                    skip: offset,
                    orderBy,
                }),
                prisma.ring.count({ where }),
            ]);

            const ringResponses = await Promise.all(
                rings.map(ring => buildRingResponse(ring, false, false, request.actor?.did))
            );

            const response: RingListResponse = {
                rings: ringResponses,
                total,
                limit,
                offset,
                hasMore: offset + limit < total,
            };

            reply.send(response);
        } catch (error) {
            logger.error({ error }, 'Failed to list rings');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve rings',
            });
        }
    });

    /**
     * GET /trp/rings/trending - Get trending rings
     */
    fastify.get<{ Querystring: TrendingQueryInput }>('/rings/trending', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    timeWindow: { type: 'string', enum: ['hour', 'day', 'week', 'month'], default: 'day' },
                    limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
                },
            },
            tags: ['rings'],
            summary: 'Get trending rings',
        },
    }, async (request, reply) => {
        try {
            const { timeWindow, limit } = request.query;

            // Calculate time cutoff
            const now = new Date();
            const cutoff = new Date();
            switch (timeWindow) {
                case 'hour':
                    cutoff.setHours(now.getHours() - 1);
                    break;
                case 'day':
                    cutoff.setDate(now.getDate() - 1);
                    break;
                case 'week':
                    cutoff.setDate(now.getDate() - 7);
                    break;
                case 'month':
                    cutoff.setMonth(now.getMonth() - 1);
                    break;
            }

            // For now, we'll use a simple algorithm based on recent activity
            // In production, this would be more sophisticated
            const rings = await prisma.ring.findMany({
                where: {
                    visibility: 'PUBLIC',
                    updatedAt: { gte: cutoff },
                },
                take: limit,
                orderBy: { updatedAt: 'desc' },
            });

            const ringResponses = await Promise.all(
                rings.map(ring => buildRingResponse(ring, false, false, request.actor?.did))
            );

            reply.send({
                rings: ringResponses,
                timeWindow,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get trending rings');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve trending rings',
            });
        }
    });

    /**
     * GET /trp/rings/:slug - Get ring details
     */
    fastify.get<{ Params: { slug: string } }>('/rings/:slug', {
        schema: {
            params: {
                type: 'object',
                properties: {
                    slug: { type: 'string' },
                },
                required: ['slug'],
            },
            tags: ['rings'],
            summary: 'Get ring details',
        },
    }, async (request, reply) => {
        try {
            const { slug } = request.params;

            const ring = await prisma.ring.findUnique({
                where: { slug },
            });

            if (!ring) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            // Check visibility permissions
            if (ring.visibility === 'PRIVATE' && !request.actor) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            if (ring.visibility === 'PRIVATE' && request.actor) {
                // Check if user is a member
                const membership = await prisma.membership.findFirst({
                    where: {
                        ringId: ring.id,
                        actorDid: request.actor.did,
                        status: 'ACTIVE',
                    },
                });

                if (!membership) {
                    reply.code(404).send({
                        error: 'Not found',
                        message: 'Ring not found',
                    });
                    return;
                }
            }

            const response = await buildRingResponse(ring, true, true, request.actor?.did);
            reply.send(response);
        } catch (error) {
            logger.error({ error }, 'Failed to get ring details');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve ring',
            });
        }
    });

    /**
     * GET /trp/rings/check-availability/:slug - Check if ring slug is available
     */
    fastify.get<{ Params: { slug: string } }>('/rings/check-availability/:slug', {
        schema: {
            params: {
                type: 'object',
                properties: {
                    slug: {
                        type: 'string',
                        minLength: 3,
                        maxLength: 25, // Similar to Reddit (21) but slightly more generous
                        pattern: '^[a-z0-9-]+$' // Only lowercase letters, numbers, and hyphens
                    },
                },
                required: ['slug'],
            },
            tags: ['rings'],
            summary: 'Check if ring slug is available',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        available: { type: 'boolean' },
                        slug: { type: 'string' },
                        message: { type: 'string' },
                    },
                },
                400: {
                    type: 'object',
                    properties: {
                        error: { type: 'string' },
                        message: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { slug } = request.params;

            // Additional validation for slug format
            if (slug.startsWith('-') || slug.endsWith('-')) {
                reply.code(400).send({
                    error: 'Invalid slug',
                    message: 'Slug cannot start or end with a hyphen',
                });
                return;
            }

            if (slug.includes('--')) {
                reply.code(400).send({
                    error: 'Invalid slug',
                    message: 'Slug cannot contain consecutive hyphens',
                });
                return;
            }

            // Check if ring with this slug already exists
            const existingRing = await prisma.ring.findUnique({
                where: { slug },
                select: { id: true, name: true, visibility: true },
            });

            const available = !existingRing;

            reply.send({
                available,
                slug,
                message: available
                    ? `Ring slug '${slug}' is available`
                    : `Ring slug '${slug}' is already taken`,
            });
        } catch (error) {
            logger.error({ error, slug: request.params.slug }, 'Failed to check ring availability');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to check ring availability',
            });
        }
    });

    /**
     * POST /trp/rings - Create a new ring
     */
    fastify.post<{ Body: CreateRingInput }>('/rings', {
        preHandler: [authenticateActor, requireVerifiedActor],
        schema: {
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    slug: {
                        type: 'string',
                        minLength: 3,
                        maxLength: 25,
                        pattern: '^[a-z0-9-]+$'
                    },
                    description: { type: 'string', maxLength: 500 },
                    shortCode: { type: 'string', minLength: 2, maxLength: 10, pattern: '^[a-zA-Z0-9-]+$' },
                    visibility: { type: 'string', enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'], default: 'PUBLIC' },
                    joinPolicy: { type: 'string', enum: ['OPEN', 'APPLICATION', 'INVITATION', 'CLOSED'], default: 'OPEN' },
                    postPolicy: { type: 'string', enum: ['OPEN', 'MEMBERS', 'CURATED', 'CLOSED'], default: 'OPEN' },
                    parentSlug: { type: 'string' },
                    curatorNote: { type: 'string', maxLength: 1000 },
                    bannerUrl: { type: 'string', format: 'uri' },
                    themeColor: { type: 'string' },
                    badgeImageUrl: { type: 'string', format: 'uri' },
                    badgeImageHighResUrl: { type: 'string', format: 'uri' },
                    metadata: { type: 'object' },
                    policies: { type: 'object' },
                },
                required: ['name'],
            },
            tags: ['rings'],
            summary: 'Create a new ring',
            security: [{ httpSignature: [] }],
        },
    }, async (request, reply) => {
        try {
            const data = request.body;
            const actorDid = request.actor!.did;

            // Check if parent exists (for forks)
            let parentRing = null;
            if (data.parentSlug) {
                parentRing = await prisma.ring.findUnique({
                    where: { slug: data.parentSlug },
                });

                if (!parentRing) {
                    reply.code(400).send({
                        error: 'Invalid parent',
                        message: 'Parent ring not found',
                    });
                    return;
                }
            }

            // Handle custom slug or generate from name
            let slug: string;

            if (data.slug) {
                // Validate custom slug
                if (data.slug.startsWith('-') || data.slug.endsWith('-')) {
                    reply.code(400).send({
                        error: 'Invalid slug',
                        message: 'Slug cannot start or end with a hyphen',
                    });
                    return;
                }

                if (data.slug.includes('--')) {
                    reply.code(400).send({
                        error: 'Invalid slug',
                        message: 'Slug cannot contain consecutive hyphens',
                    });
                    return;
                }

                // Check if custom slug is already taken
                const existingRing = await prisma.ring.findUnique({
                    where: { slug: data.slug },
                });

                if (existingRing) {
                    reply.code(400).send({
                        error: 'Slug unavailable',
                        message: `Ring slug '${data.slug}' is already taken`,
                    });
                    return;
                }

                slug = data.slug;
            } else {
                // Generate unique slug from name
                const existingSlugs = await prisma.ring.findMany({
                    select: { slug: true },
                });
                slug = generateSlug(data.name, existingSlugs.map(r => r.slug));
            }

            // Create the ring
            const ring = await prisma.ring.create({
                data: {
                    slug,
                    name: data.name,
                    description: data.description,
                    shortCode: data.shortCode,
                    visibility: data.visibility,
                    joinPolicy: data.joinPolicy,
                    postPolicy: data.postPolicy,
                    ownerDid: actorDid,
                    parentId: parentRing?.id,
                    curatorNote: data.curatorNote,
                    bannerUrl: data.bannerUrl,
                    themeColor: data.themeColor,
                    badgeImageUrl: data.badgeImageUrl,
                    badgeImageHighResUrl: data.badgeImageHighResUrl,
                    metadata: data.metadata,
                    policies: data.policies,
                },
            });

            // Create default roles
            const [ownerRole] = await Promise.all([
                prisma.ringRole.create({
                    data: {
                        ringId: ring.id,
                        name: 'owner',
                        permissions: [
                            'manage_ring',
                            'manage_members',
                            'manage_roles',
                            'moderate_posts',
                            'update_ring_info',
                            'delete_ring',
                        ],
                    },
                }),
                prisma.ringRole.create({
                    data: {
                        ringId: ring.id,
                        name: 'member',
                        permissions: ['submit_posts', 'view_content'],
                    },
                }),
            ]);

            // Add owner as member with owner role
            await prisma.membership.create({
                data: {
                    ringId: ring.id,
                    actorDid,
                    roleId: ownerRole.id,
                    status: 'ACTIVE',
                },
            });

            // Log the action
            await prisma.auditLog.create({
                data: {
                    ringId: ring.id,
                    action: 'ring.created',
                    actorDid,
                    metadata: {
                        ringName: ring.name,
                        parentSlug: data.parentSlug,
                    },
                },
            });

            logger.info({
                ringSlug: ring.slug,
                ownerDid: actorDid,
                parentSlug: data.parentSlug,
            }, 'Ring created');

            const response = await buildRingResponse(ring, true, false, actorDid);
            reply.code(201).send(response);
        } catch (error) {
            logger.error({ error }, 'Failed to create ring');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to create ring',
            });
        }
    });
    /**
     * PUT /trp/rings/:slug - Update ring
     */
    fastify.put<{ Params: { slug: string }; Body: UpdateRingInput }>('/rings/:slug', {
        preHandler: [
            authenticateActor,
            requireVerifiedActor,
            requireNotBlocked(),
            requireMembership(),
            requirePermission('manage_ring'),
        ],
        schema: {
            params: {
                type: 'object',
                properties: {
                    slug: { type: 'string' },
                },
                required: ['slug'],
            },
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    description: { type: 'string', maxLength: 500 },
                    shortCode: { type: 'string', minLength: 2, maxLength: 10, pattern: '^[a-zA-Z0-9-]+$' },
                    visibility: { type: 'string', enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'] },
                    joinPolicy: { type: 'string', enum: ['OPEN', 'APPLICATION', 'INVITATION', 'CLOSED'] },
                    postPolicy: { type: 'string', enum: ['OPEN', 'MEMBERS', 'CURATED', 'CLOSED'] },
                    parentSlug: { type: 'string' },
                    curatorNote: { type: 'string', maxLength: 1000 },
                    bannerUrl: { type: 'string', format: 'uri' },
                    themeColor: { type: 'string' },
                    badgeImageUrl: { type: 'string', format: 'uri' },
                    badgeImageHighResUrl: { type: 'string', format: 'uri' },
                    metadata: { type: 'object' },
                    policies: { type: 'object' },
                },
            },
            tags: ['rings'],
            summary: 'Update ring',
            security: [{ httpSignature: [] }],
        },
    }, async (request, reply) => {
        try {
            const { slug } = request.params;
            const data = request.body;
            const actorDid = request.actor!.did;

            const ring = await prisma.ring.findUnique({
                where: { slug },
            });

            if (!ring) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            // Check if attempting to update parent relationship
            if (data.parentSlug !== undefined) {
                // Prevent moving the root ring itself
                if (ring.slug === config.rings.rootSlug) {
                    reply.code(400).send({
                        error: 'Invalid operation',
                        message: 'The root ring cannot have its parent changed',
                    });
                    return;
                }

                // For parent updates, require either ring owner or admin override
                const isOwner = ring.ownerDid === actorDid;
                const isAdmin = await prisma.actor.findUnique({
                    where: { did: actorDid },
                    select: { isAdmin: true }
                });

                if (!isOwner && !isAdmin?.isAdmin) {
                    reply.code(403).send({
                        error: 'Insufficient permissions',
                        message: 'Only ring owners or administrators can change parent relationships',
                    });
                    return;
                }
            }

            // Validate parent ring if parentSlug is provided
            let newParentId = ring.parentId; // Keep current parent if not specified
            if (data.parentSlug !== undefined) {
                let targetParentSlug = data.parentSlug;

                // If null or empty string, default to root ring
                if (data.parentSlug === null || data.parentSlug === '') {
                    targetParentSlug = config.rings.rootSlug;
                }

                // Don't allow setting parent to itself
                if (targetParentSlug === slug) {
                    reply.code(400).send({
                        error: 'Invalid parent',
                        message: 'Ring cannot be its own parent',
                    });
                    return;
                }

                // Find the new parent ring
                const parentRing = await prisma.ring.findUnique({
                    where: { slug: targetParentSlug },
                });

                if (!parentRing) {
                    reply.code(400).send({
                        error: 'Invalid parent',
                        message: `Parent ring '${targetParentSlug}' not found`,
                    });
                    return;
                }

                // Prevent circular references by checking if the parent ring is a descendant of current ring
                let checkRing = parentRing;
                const visited = new Set([ring.id]);
                while (checkRing.parentId) {
                    if (visited.has(checkRing.parentId)) {
                        reply.code(400).send({
                            error: 'Invalid parent',
                            message: 'Cannot create circular parent-child relationship',
                        });
                        return;
                    }
                    visited.add(checkRing.parentId);

                    const nextParent = await prisma.ring.findUnique({
                        where: { id: checkRing.parentId },
                    });
                    if (!nextParent) break;
                    checkRing = nextParent;
                }

                newParentId = parentRing.id;
            }

            // Update the ring
            const updatedRing = await prisma.ring.update({
                where: { slug },
                data: {
                    name: data.name,
                    description: data.description,
                    shortCode: data.shortCode,
                    visibility: data.visibility,
                    joinPolicy: data.joinPolicy,
                    postPolicy: data.postPolicy,
                    parentId: newParentId,
                    curatorNote: data.curatorNote,
                    bannerUrl: data.bannerUrl,
                    themeColor: data.themeColor,
                    badgeImageUrl: data.badgeImageUrl,
                    badgeImageHighResUrl: data.badgeImageHighResUrl,
                    metadata: data.metadata,
                    policies: data.policies,
                    updatedAt: new Date(),
                },
            });

            // Log the action
            const auditAction = data.parentSlug !== undefined ? 'ring.parent_updated' : 'ring.updated';
            await prisma.auditLog.create({
                data: {
                    ringId: ring.id,
                    action: auditAction,
                    actorDid,
                    metadata: {
                        changes: data,
                        previousParentId: ring.parentId,
                        newParentId: newParentId,
                        parentSlugChanged: data.parentSlug !== undefined,
                        movedToRoot: data.parentSlug !== undefined && (data.parentSlug === null || data.parentSlug === ''),
                    },
                },
            });

            logger.info({
                ringSlug: slug,
                updatedBy: actorDid,
            }, 'Ring updated');

            const response = await buildRingResponse(updatedRing, true, true, actorDid);
            reply.send(response);
        } catch (error) {
            logger.error({ error }, 'Failed to update ring');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to update ring',
            });
        }
    });

    /**
     * DELETE /trp/rings/:slug - Delete ring (soft delete)
     */
    fastify.delete<{ Params: { slug: string } }>('/rings/:slug', {
        preHandler: [
            authenticateActor,
            requireVerifiedActor,
            requireNotBlocked(),
            requireMembership(),
            requirePermission('delete_ring'),
        ],
        schema: {
            params: {
                type: 'object',
                properties: {
                    slug: { type: 'string' },
                },
                required: ['slug'],
            },
            tags: ['rings'],
            summary: 'Delete ring',
            security: [{ httpSignature: [] }],
        },
    }, async (request, reply) => {
        try {
            const { slug } = request.params;
            const actorDid = request.actor!.did;

            const ring = await prisma.ring.findUnique({
                where: { slug },
            });

            if (!ring) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            // For now, we'll do a hard delete
            // In production, implement soft delete
            await prisma.ring.delete({
                where: { slug },
            });

            logger.info({
                ringSlug: slug,
                deletedBy: actorDid,
            }, 'Ring deleted');

            reply.code(204).send();
        } catch (error) {
            logger.error({ error }, 'Failed to delete ring');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to delete ring',
            });
        }
    });

    /**
     * POST /trp/fork - Fork a ring
     */
    fastify.post<{ Body: ForkRingInput & { parentSlug: string } }>('/fork', {
        preHandler: [
            authenticateActor,
            requireVerifiedActor,
            rateLimit({ action: 'fork_ring' })
        ],
        schema: {
            body: {
                type: 'object',
                properties: {
                    parentSlug: { type: 'string' },
                    name: { type: 'string' },
                    slug: {
                        type: 'string',
                        minLength: 3,
                        maxLength: 25,
                        pattern: '^[a-z0-9-]+$'
                    },
                    description: { type: 'string' },
                    shortCode: { type: 'string' },
                    visibility: { type: 'string', enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'] },
                    joinPolicy: { type: 'string', enum: ['OPEN', 'APPLICATION', 'INVITATION', 'CLOSED'] },
                    postPolicy: { type: 'string', enum: ['OPEN', 'MEMBERS', 'CURATED', 'CLOSED'] },
                    curatorNote: { type: 'string' },
                    badgeImageUrl: { type: 'string', format: 'uri' },
                    badgeImageHighResUrl: { type: 'string', format: 'uri' },
                    metadata: { type: 'object' },
                },
                required: ['parentSlug', 'name'],
            },
            tags: ['rings'],
            summary: 'Fork a ring',
            security: [{ httpSignature: [] }],
        },
    }, async (request, reply) => {
        try {
            const data = request.body;
            const actorDid = request.actor!.did;

            // Get parent ring
            const parentRing = await prisma.ring.findUnique({
                where: { slug: data.parentSlug },
            });

            if (!parentRing) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Parent ring not found',
                });
                return;
            }

            // Handle custom slug or generate from name
            let slug: string;

            if (data.slug) {
                // Validate custom slug
                if (data.slug.startsWith('-') || data.slug.endsWith('-')) {
                    reply.code(400).send({
                        error: 'Invalid slug',
                        message: 'Slug cannot start or end with a hyphen',
                    });
                    return;
                }

                if (data.slug.includes('--')) {
                    reply.code(400).send({
                        error: 'Invalid slug',
                        message: 'Slug cannot contain consecutive hyphens',
                    });
                    return;
                }

                // Check if custom slug is already taken
                const existingRing = await prisma.ring.findUnique({
                    where: { slug: data.slug },
                });

                if (existingRing) {
                    reply.code(400).send({
                        error: 'Slug unavailable',
                        message: `Ring slug '${data.slug}' is already taken`,
                    });
                    return;
                }

                slug = data.slug;
            } else {
                // Generate unique slug from name
                const existingSlugs = await prisma.ring.findMany({
                    select: { slug: true },
                });
                slug = generateSlug(data.name, existingSlugs.map(r => r.slug));
            }

            // Create the fork
            const ring = await prisma.ring.create({
                data: {
                    slug,
                    name: data.name,
                    description: data.description,
                    shortCode: data.shortCode,
                    visibility: data.visibility,
                    joinPolicy: data.joinPolicy,
                    postPolicy: data.postPolicy,
                    ownerDid: actorDid,
                    parentId: parentRing.id,
                    curatorNote: data.curatorNote,
                    badgeImageUrl: data.badgeImageUrl,
                    badgeImageHighResUrl: data.badgeImageHighResUrl,
                    metadata: {
                        ...data.metadata,
                        forkedFrom: parentRing.slug,
                        forkedAt: new Date().toISOString(),
                    },
                },
            });

            // Create default roles (copy from parent if desired)
            const [ownerRole] = await Promise.all([
                prisma.ringRole.create({
                    data: {
                        ringId: ring.id,
                        name: 'owner',
                        permissions: [
                            'manage_ring',
                            'manage_members',
                            'manage_roles',
                            'moderate_posts',
                            'update_ring_info',
                            'delete_ring',
                        ],
                    },
                }),
                prisma.ringRole.create({
                    data: {
                        ringId: ring.id,
                        name: 'member',
                        permissions: ['submit_posts', 'view_content'],
                    },
                }),
            ]);

            // Add owner as member
            const membership = await prisma.membership.create({
                data: {
                    ringId: ring.id,
                    actorDid,
                    roleId: ownerRole.id,
                    status: 'ACTIVE',
                    joinedAt: new Date(), // Set joined date for badge generation
                },
            });

            // Generate badge for fork creator (owner)
            let badge = null;
            try {
                // Badge generation for fork owner

                // TODO: Use proper private key from environment
                const RING_HUB_PRIVATE_KEY = crypto.generateKeyPairSync('ed25519').privateKey;

                const RING_HUB_URL = process.env.RING_HUB_URL || 'https://ringhub.io';

                badge = await generateBadge(
                    ring.slug,
                    ring.name,
                    actorDid,
                    'owner', // Role name
                    RING_HUB_PRIVATE_KEY,
                    RING_HUB_URL,
                    ring.badgeImageUrl || undefined,
                    ring.badgeImageHighResUrl || undefined
                );

                // Update membership with badge ID
                await prisma.membership.update({
                    where: { id: membership.id },
                    data: { badgeId: badge.id },
                });

                // Store badge in database
                await prisma.badge.create({
                    data: {
                        id: badge.id,
                        membershipId: membership.id,
                        badgeData: badge,
                        issuedAt: new Date(),
                    },
                });

                logger.info({
                    ringSlug: ring.slug,
                    badgeId: badge.id,
                    forkedBy: actorDid,
                }, 'Fork owner badge generated');

            } catch (error) {
                logger.error({ error, ringSlug: ring.slug, actorDid }, 'Failed to generate fork owner badge');
                // Continue without badge - don't fail the fork
            }

            // Log the fork
            await prisma.auditLog.create({
                data: {
                    ringId: ring.id,
                    action: 'ring.forked',
                    actorDid,
                    metadata: {
                        parentSlug: parentRing.slug,
                        parentId: parentRing.id,
                    },
                },
            });

            logger.info({
                ringSlug: ring.slug,
                parentSlug: parentRing.slug,
                forkedBy: actorDid,
            }, 'Ring forked');

            // Record rate limit usage
            await recordRateLimitUsage(request, 'fork_ring', { ringId: ring.id });

            const response = await buildRingResponse(ring, true, false, actorDid);
            reply.code(201).send(response);
        } catch (error) {
            logger.error({ error }, 'Failed to fork ring');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to fork ring',
            });
        }
    });

    /**
     * GET /trp/rings/:slug/lineage - Get ring genealogy
     */
    fastify.get<{ Params: { slug: string } }>('/rings/:slug/lineage', {
        schema: {
            params: {
                type: 'object',
                properties: {
                    slug: { type: 'string' },
                },
                required: ['slug'],
            },
            tags: ['rings'],
            summary: 'Get ring genealogy',
        },
    }, async (request, reply) => {
        try {
            const { slug } = request.params;

            const ring = await prisma.ring.findUnique({
                where: { slug },
            });

            if (!ring) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            // Check if user can access private ring lineage
            if (ring.visibility === 'PRIVATE' && request.actor) {
                const membership = await prisma.membership.findFirst({
                    where: {
                        ringId: ring.id,
                        actorDid: request.actor.did,
                        status: 'ACTIVE',
                    },
                });

                if (!membership) {
                    reply.code(404).send({
                        error: 'Not found',
                        message: 'Ring not found',
                    });
                    return;
                }
            } else if (ring.visibility === 'PRIVATE' && !request.actor) {
                // Private ring, no authentication provided
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            // Helper function to check if user can see a ring
            async function canSeeRing(targetRing: any): Promise<boolean> {
                if (targetRing.visibility === 'PUBLIC') return true;
                if (targetRing.visibility === 'UNLISTED') return true; // Visible if you know the lineage
                if (targetRing.visibility === 'PRIVATE' && !request.actor) return false;

                if (targetRing.visibility === 'PRIVATE' && request.actor) {
                    const membership = await prisma.membership.findFirst({
                        where: {
                            ringId: targetRing.id,
                            actorDid: request.actor.did,
                            status: 'ACTIVE',
                        },
                    });
                    return !!membership;
                }

                return false;
            }

            // Build complete genealogy
            const ancestors = [];
            let currentRing = ring;

            while (currentRing.parentId) {
                const parent = await prisma.ring.findUnique({
                    where: { id: currentRing.parentId },
                });

                if (!parent) break;

                // Only include if user can see this ring
                if (await canSeeRing(parent)) {
                    ancestors.unshift(await buildRingResponse(parent, false, false, request.actor?.did));
                }
                currentRing = parent;
            }

            // Helper function to count total descendants (recursive)
            async function countDescendants(ringId: string): Promise<number> {
                const children = await prisma.ring.findMany({
                    where: { parentId: ringId },
                    select: { id: true },
                });

                let count = children.length;
                for (const child of children) {
                    count += await countDescendants(child.id);
                }

                return count;
            }

            // Get all descendants (filtered by visibility)
            async function getDescendants(ringId: string): Promise<any[]> {
                const children = await prisma.ring.findMany({
                    where: { parentId: ringId },
                });

                const visibleChildren = [];
                for (const child of children) {
                    if (await canSeeRing(child)) {
                        const childDescendants = await getDescendants(child.id);
                        const descendantCount = await countDescendants(child.id);

                        visibleChildren.push({
                            ...await buildRingResponse(child, false, false, request.actor?.did),
                            descendantCount,
                            children: childDescendants,
                        });
                    }
                }

                return visibleChildren;
            }

            const descendants = await getDescendants(ring.id);

            reply.send({
                ring: await buildRingResponse(ring, false, false, request.actor?.did),
                ancestors,
                descendants,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get ring lineage');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve ring lineage',
            });
        }
    });

    /**
     * GET /trp/rings/:slug/members - Get ring members
     */
    fastify.get<{
        Params: { slug: string };
        Querystring: MemberQueryInput
    }>('/rings/:slug/members', {
        schema: {
            params: {
                type: 'object',
                properties: {
                    slug: { type: 'string' },
                },
                required: ['slug'],
            },
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
                    offset: { type: 'number', minimum: 0, default: 0 },
                    status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED'] },
                    role: { type: 'string' },
                },
            },
            tags: ['rings'],
            summary: 'Get ring members',
        },
    }, async (request, reply) => {
        try {
            const { slug } = request.params;
            const { limit, offset, status, role } = request.query;

            const ring = await prisma.ring.findUnique({
                where: { slug },
            });

            if (!ring) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            // Check if ring is private and user has access
            if (ring.visibility === 'PRIVATE' && !request.actor) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            const where: any = { ringId: ring.id };
            // Default to ACTIVE members only, unless specific status requested
            where.status = status || 'ACTIVE';
            if (role) {
                where.role = { name: role };
            }

            const [memberships, total] = await Promise.all([
                prisma.membership.findMany({
                    where,
                    include: {
                        role: { select: { name: true } },
                    },
                    take: limit,
                    skip: offset,
                    orderBy: { joinedAt: 'desc' },
                }),
                prisma.membership.count({ where }),
            ]);

            // Get actor names
            const actorDids = memberships.map(m => m.actorDid);
            const actors = await prisma.actor.findMany({
                where: { did: { in: actorDids } },
                select: { did: true, name: true },
            });

            const actorNameMap = new Map(actors.map(a => [a.did, a.name]));

            const members = memberships.map(m => {
                // Build handles array from profile data
                const handles = [];
                if (m.handle && m.instanceDomain && m.profileUrl) {
                    handles.push({
                        handle: m.handle,
                        domain: m.instanceDomain,
                        url: m.profileUrl,
                    });
                }

                return {
                    actorDid: m.actorDid,
                    // Prefer profile data from membership (from DID resolution), fallback to Actor table
                    actorName: m.actorName || actorNameMap.get(m.actorDid) || null,
                    avatarUrl: m.avatarUrl || null,
                    profileUrl: m.profileUrl || null,
                    instanceDomain: m.instanceDomain || null,
                    handles,
                    status: m.status,
                    role: m.role?.name || null,
                    joinedAt: m.joinedAt?.toISOString() || null,
                    badgeId: m.badgeId,
                };
            });

            const response: MembersListResponse = {
                members,
                total,
                limit,
                offset,
                hasMore: offset + limit < total,
            };

            reply.send(response);
        } catch (error) {
            logger.error({
                error: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
                ringSlug: request.params.slug
            }, 'Failed to get ring members');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve ring members',
            });
        }
    });

    /**
     * GET /trp/rings/:slug/membership-info - Get public membership information
     * Returns total member count and info about curators/moderators
     * This is a public endpoint - no authentication required
     */
    fastify.get<{
        Params: { slug: string }
    }>('/rings/:slug/membership-info', {
        schema: {
            params: {
                type: 'object',
                properties: {
                    slug: { type: 'string' },
                },
                required: ['slug'],
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        memberCount: { type: 'number' },
                        owner: {
                            type: 'object',
                            nullable: true,
                            properties: {
                                actorDid: { type: 'string' },
                                actorName: { type: 'string', nullable: true },
                                joinedAt: { type: 'string', nullable: true },
                            },
                        },
                        moderators: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    actorDid: { type: 'string' },
                                    actorName: { type: 'string', nullable: true },
                                    role: { type: 'string' },
                                    joinedAt: { type: 'string', nullable: true },
                                },
                            },
                        },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { slug } = request.params;
        const logger = request.log;

        try {
            // Find the ring
            const ring = await prisma.ring.findUnique({
                where: { slug },
                select: {
                    id: true,
                    ownerDid: true,
                    visibility: true,
                },
            });

            if (!ring) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            // Check if ring is private - if so, return limited info
            if (ring.visibility === 'PRIVATE') {
                reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Ring membership information is private',
                });
                return;
            }

            // Get total member count
            const memberCount = await prisma.membership.count({
                where: {
                    ringId: ring.id,
                    status: 'ACTIVE',
                },
            });

            // Get roles with moderation/management permissions
            const moderatorRoles = await prisma.ringRole.findMany({
                where: {
                    ringId: ring.id,
                    OR: [
                        { name: 'owner' },
                        { name: 'moderator' },
                        { name: 'admin' },
                        {
                            permissions: {
                                array_contains: 'moderate_posts',
                            },
                        },
                        {
                            permissions: {
                                array_contains: 'manage_ring',
                            },
                        },
                    ],
                },
                select: {
                    id: true,
                    name: true,
                },
            });

            // Get members with moderator roles
            const moderatorMembers = await prisma.membership.findMany({
                where: {
                    ringId: ring.id,
                    status: 'ACTIVE',
                    roleId: {
                        in: moderatorRoles.map(r => r.id),
                    },
                },
                include: {
                    role: {
                        select: { name: true },
                    },
                },
            });

            // Get actor names for moderators
            const actorDids = moderatorMembers.map(m => m.actorDid);
            const actors = await prisma.actor.findMany({
                where: { did: { in: actorDids } },
                select: { did: true, name: true },
            });

            const actorNameMap = new Map(actors.map(a => [a.did, a.name]));

            // Find owner info
            const ownerMember = moderatorMembers.find(m => m.actorDid === ring.ownerDid);
            const owner = ownerMember ? {
                actorDid: ownerMember.actorDid,
                actorName: actorNameMap.get(ownerMember.actorDid) || null,
                joinedAt: ownerMember.joinedAt?.toISOString() || null,
            } : null;

            // Format moderators (excluding owner to avoid duplication)
            const moderators = moderatorMembers
                .filter(m => m.actorDid !== ring.ownerDid)
                .map(m => ({
                    actorDid: m.actorDid,
                    actorName: actorNameMap.get(m.actorDid) || null,
                    role: m.role?.name || 'moderator',
                    joinedAt: m.joinedAt?.toISOString() || null,
                }));

            reply.send({
                memberCount,
                owner,
                moderators,
            });
        } catch (error) {
            logger.error({
                error: error instanceof Error ? error.message : String(error),
                ringSlug: slug
            }, 'Failed to get ring membership info');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to retrieve membership information',
            });
        }
    });
    /**
     * PUT /trp/rings/:slug/badge - Update ring badge configuration
     */
    fastify.put<{
        Params: { slug: string };
        Body: {
            badgeImageUrl?: string;
            badgeImageHighResUrl?: string;
            updateExistingBadges?: boolean;
            badgeMetadata?: {
                description?: string;
                criteria?: string;
            };
        };
    }>('/rings/:slug/badge', {
        preHandler: [
            authenticateActor,
            requireVerifiedActor,
            requireNotBlocked(),
            requireMembership(),
            requirePermission('manage_ring'),
        ],
        schema: {
            params: {
                type: 'object',
                properties: {
                    slug: { type: 'string' },
                },
                required: ['slug'],
            },
            body: {
                type: 'object',
                properties: {
                    badgeImageUrl: {
                        type: 'string',
                        format: 'uri',
                        description: 'URL for standard badge image (88x31px recommended)'
                    },
                    badgeImageHighResUrl: {
                        type: 'string',
                        format: 'uri',
                        description: 'URL for high-resolution badge image (352x124px recommended)'
                    },
                    updateExistingBadges: {
                        type: 'boolean',
                        default: false,
                        description: 'Whether to regenerate existing badges with new images'
                    },
                    badgeMetadata: {
                        type: 'object',
                        properties: {
                            description: { type: 'string', maxLength: 500 },
                            criteria: { type: 'string', maxLength: 500 }
                        },
                        description: 'Additional metadata for badge criteria and description'
                    }
                },
                additionalProperties: false
            },
            tags: ['rings'],
            summary: 'Update ring badge configuration',
            description: 'Update badge images and optionally regenerate existing badges for all ring members',
            security: [{ httpSignature: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        ring: {
                            type: 'object',
                            properties: {
                                slug: { type: 'string' },
                                name: { type: 'string' },
                                badgeImageUrl: { type: 'string', nullable: true },
                                badgeImageHighResUrl: { type: 'string', nullable: true },
                                updatedAt: { type: 'string', format: 'date-time' }
                            }
                        },
                        badgesUpdated: {
                            type: 'object',
                            properties: {
                                total: { type: 'number' },
                                updated: { type: 'number' },
                                failed: { type: 'number' }
                            },
                            nullable: true
                        },
                        message: { type: 'string' }
                    }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { slug } = request.params;
            const {
                badgeImageUrl,
                badgeImageHighResUrl,
                updateExistingBadges = false,
                badgeMetadata
            } = request.body;
            const actorDid = request.actor!.did;

            // Find the ring
            const ring = await prisma.ring.findUnique({
                where: { slug },
                select: {
                    id: true,
                    slug: true,
                    name: true,
                    ownerDid: true,
                    badgeImageUrl: true,
                    badgeImageHighResUrl: true
                }
            });

            if (!ring) {
                reply.code(404).send({
                    error: 'Not found',
                    message: 'Ring not found',
                });
                return;
            }

            // Check if actor is ring owner (additional check beyond middleware)
            if (ring.ownerDid !== actorDid) {
                reply.code(403).send({
                    error: 'Forbidden',
                    message: 'Only ring owners can update badge configuration',
                });
                return;
            }

            // Validate at least one update field is provided
            if (!badgeImageUrl && !badgeImageHighResUrl && !badgeMetadata) {
                reply.code(400).send({
                    error: 'Bad request',
                    message: 'At least one update field must be provided',
                });
                return;
            }

            // Update ring badge configuration
            const updatedRing = await prisma.ring.update({
                where: { slug },
                data: {
                    ...(badgeImageUrl !== undefined && { badgeImageUrl }),
                    ...(badgeImageHighResUrl !== undefined && { badgeImageHighResUrl }),
                    updatedAt: new Date(),
                },
            });

            let badgesUpdated = null;

            // Regenerate existing badges if requested
            if (updateExistingBadges) {
                try {
                    // Get all active memberships for this ring
                    const memberships = await prisma.membership.findMany({
                        where: {
                            ringId: ring.id,
                            status: 'ACTIVE',
                            badgeId: { not: null } // Only update existing badges
                        },
                        include: {
                            role: { select: { name: true } }
                        }
                    });

                    let updated = 0;
                    let failed = 0;

                    for (const membership of memberships) {
                        try {
                            // Generate new badge with updated images
                            const newBadge = await generateBadge(
                                ring.slug,
                                ring.name,
                                membership.actorDid,
                                membership.role?.name || 'member',
                                crypto.generateKeyPairSync('ed25519').privateKey,
                                process.env.RING_HUB_URL || 'https://ringhub.io',
                                updatedRing.badgeImageUrl || undefined,
                                updatedRing.badgeImageHighResUrl || undefined
                            );

                            // Update badge in database
                            await prisma.badge.update({
                                where: { id: membership.badgeId! },
                                data: {
                                    badgeData: {
                                        ...newBadge,
                                        ...(badgeMetadata && {
                                            credentialSubject: {
                                                ...newBadge.credentialSubject,
                                                achievement: {
                                                    ...newBadge.credentialSubject.achievement,
                                                    ...(badgeMetadata.description && {
                                                        description: badgeMetadata.description
                                                    }),
                                                    ...(badgeMetadata.criteria && {
                                                        criteria: { narrative: badgeMetadata.criteria }
                                                    })
                                                }
                                            }
                                        })
                                    },
                                    issuedAt: new Date() // Update issued date
                                }
                            });

                            updated++;

                        } catch (error) {
                            logger.error({
                                error,
                                membershipId: membership.id,
                                badgeId: membership.badgeId,
                                ringSlug: slug
                            }, 'Failed to regenerate badge');
                            failed++;
                        }
                    }

                    badgesUpdated = {
                        total: memberships.length,
                        updated,
                        failed
                    };

                    logger.info({
                        ringSlug: slug,
                        badgesUpdated,
                        actorDid,
                    }, 'Badge regeneration completed');

                } catch (error) {
                    logger.error({ error, ringSlug: slug }, 'Failed to regenerate badges');
                    // Continue with response - don't fail the ring update
                }
            }

            // Log the action
            await prisma.auditLog.create({
                data: {
                    ringId: ring.id,
                    action: 'ring.badge_updated',
                    actorDid,
                    metadata: {
                        badgeImageUrl: updatedRing.badgeImageUrl,
                        badgeImageHighResUrl: updatedRing.badgeImageHighResUrl,
                        updateExistingBadges,
                        badgesUpdated,
                        badgeMetadata
                    },
                },
            });

            const responseMessage = updateExistingBadges
                ? `Ring badge configuration updated and ${badgesUpdated?.updated || 0} existing badges regenerated`
                : 'Ring badge configuration updated. New badges will use updated images.';

            reply.send({
                success: true,
                message: responseMessage,
                badgeImageUrl: updatedRing.badgeImageUrl,
                badgeImageHighResUrl: updatedRing.badgeImageHighResUrl,
                description: badgeMetadata?.description,
                criteria: badgeMetadata?.criteria,
                badgesUpdated: badgesUpdated?.updated
            });

        } catch (error) {
            logger.error({ error }, 'Failed to update ring badge configuration');
            reply.code(500).send({
                error: 'Internal error',
                message: 'Failed to update ring badge configuration',
            });
        }
    });
}
