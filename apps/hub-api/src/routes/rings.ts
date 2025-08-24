import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { 
  authenticateActor, 
  requireVerifiedActor, 
  requireNotBlocked,
  requireMembership,
  requirePermission,
  auditLogger 
} from '../security/middleware';
import {
  CreateRingSchema,
  UpdateRingSchema,
  RingQuerySchema,
  MemberQuerySchema,
  TrendingQuerySchema,
  ForkRingSchema,
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
  includeChildren = false
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
  }, async (request, reply) => {
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

      const response = await buildRingResponse(ring, true, true);
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
   * GET /trp/rings - List and search rings
   */
  fastify.get<{ Querystring: RingQueryInput }>('/rings', {
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
      const { search, visibility, limit, offset, sort, order } = request.query;

      const where: any = {};

      // Only show public rings to unauthenticated users
      if (!request.actor) {
        where.visibility = 'PUBLIC';
      } else if (visibility) {
        where.visibility = visibility;
      }

      // Search functionality
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { shortCode: { contains: search, mode: 'insensitive' } },
        ];
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
        rings.map(ring => buildRingResponse(ring))
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
        rings.map(ring => buildRingResponse(ring))
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

      const response = await buildRingResponse(ring, true, true);
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
          description: { type: 'string', maxLength: 500 },
          shortCode: { type: 'string', minLength: 2, maxLength: 10, pattern: '^[a-zA-Z0-9-]+$' },
          visibility: { type: 'string', enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'], default: 'PUBLIC' },
          joinPolicy: { type: 'string', enum: ['OPEN', 'APPLICATION', 'INVITATION', 'CLOSED'], default: 'OPEN' },
          postPolicy: { type: 'string', enum: ['OPEN', 'MEMBERS', 'CURATED', 'CLOSED'], default: 'OPEN' },
          parentSlug: { type: 'string' },
          curatorNote: { type: 'string', maxLength: 1000 },
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

      // Generate unique slug
      const existingSlugs = await prisma.ring.findMany({
        select: { slug: true },
      });
      const slug = generateSlug(data.name, existingSlugs.map(r => r.slug));

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

      const response = await buildRingResponse(ring, true, false);
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
          curatorNote: { type: 'string', maxLength: 1000 },
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
          curatorNote: data.curatorNote,
          badgeImageUrl: data.badgeImageUrl,
          badgeImageHighResUrl: data.badgeImageHighResUrl,
          metadata: data.metadata,
          policies: data.policies,
          updatedAt: new Date(),
        },
      });

      // Log the action
      await prisma.auditLog.create({
        data: {
          ringId: ring.id,
          action: 'ring.updated',
          actorDid,
          metadata: {
            changes: data,
          },
        },
      });

      logger.info({ 
        ringSlug: slug, 
        updatedBy: actorDid,
      }, 'Ring updated');

      const response = await buildRingResponse(updatedRing, true, true);
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
    preHandler: [authenticateActor, requireVerifiedActor],
    schema: {
      body: {
        type: 'object',
        properties: {
          parentSlug: { type: 'string' },
          name: { type: 'string' },
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

      // Generate unique slug
      const existingSlugs = await prisma.ring.findMany({
        select: { slug: true },
      });
      const slug = generateSlug(data.name, existingSlugs.map(r => r.slug));

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
      await prisma.membership.create({
        data: {
          ringId: ring.id,
          actorDid,
          roleId: ownerRole.id,
          status: 'ACTIVE',
        },
      });

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

      const response = await buildRingResponse(ring, true, false);
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
          ancestors.unshift(await buildRingResponse(parent));
        }
        currentRing = parent;
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
            visibleChildren.push({
              ...await buildRingResponse(child),
              children: childDescendants,
            });
          }
        }

        return visibleChildren;
      }

      const descendants = await getDescendants(ring.id);

      reply.send({
        ring: await buildRingResponse(ring),
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

      const members = memberships.map(m => ({
        actorDid: m.actorDid,
        actorName: actorNameMap.get(m.actorDid) || null,
        status: m.status,
        role: m.role?.name || null,
        joinedAt: m.joinedAt?.toISOString() || null,
        badgeId: m.badgeId,
      }));

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
        return reply.code(404).send({
          error: 'Not found',
          message: 'Ring not found',
        });
      }

      // Check if ring is private - if so, return limited info
      if (ring.visibility === 'PRIVATE') {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Ring membership information is private',
        });
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
}