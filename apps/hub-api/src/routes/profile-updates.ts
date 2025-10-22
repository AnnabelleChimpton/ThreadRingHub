import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger';
import { prisma } from '../database/prisma';
import { authenticateActor, requireVerifiedActor } from '../security/middleware';
import { refreshActorProfile, updateMembershipProfiles } from '../services/profile-resolver';

/**
 * Profile update routes
 * Handles notifications from ThreadStead instances when user profiles change
 */
export async function profileUpdateRoutes(fastify: FastifyInstance) {
  /**
   * POST /trp/actors/:did/profile-updated
   * ThreadStead notifies RingHub that a user's profile has changed
   */
  fastify.post<{
    Params: { did: string };
    Body: {
      actorDid: string;
      updatedAt: string;
    };
  }>(
    '/actors/:did/profile-updated',
    {
      preHandler: [authenticateActor, requireVerifiedActor],
      schema: {
        params: {
          type: 'object',
          properties: {
            did: { type: 'string' },
          },
          required: ['did'],
        },
        body: {
          type: 'object',
          properties: {
            actorDid: { type: 'string' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
          required: ['actorDid', 'updatedAt'],
        },
        tags: ['profile-updates'],
        summary: 'Notify profile update',
        description:
          'ThreadStead instances call this endpoint to notify RingHub when a user profile changes',
        security: [{ httpSignature: [] }],
      },
    },
    async (request, reply) => {
      try {
        const { did: paramDid } = request.params;
        const { actorDid, updatedAt } = request.body;

        // Verify the DID in params matches the body
        if (paramDid !== actorDid) {
          reply.code(400).send({
            error: 'Invalid request',
            message: 'DID in path must match actorDid in body',
          });
          return;
        }

        // Verify the authenticated actor matches the DID being updated
        // This ensures users can only update their own profiles
        if (request.actor!.did !== actorDid) {
          reply.code(403).send({
            error: 'Forbidden',
            message: 'You can only update your own profile',
          });
          return;
        }

        // Check if this actor is a member of any rings
        const membershipCount = await prisma.membership.count({
          where: { actorDid },
        });

        if (membershipCount === 0) {
          // Not a member of any rings, but return success anyway
          // (This prevents leaking membership information)
          logger.info({ did: actorDid }, 'Profile update notification for non-member (ignoring)');
          reply.code(202).send({
            status: 'accepted',
            message: 'Profile update notification received',
          });
          return;
        }

        // Rate limiting: Check for excessive updates
        const recentUpdates = await prisma.membership.count({
          where: {
            actorDid,
            profileLastFetched: {
              gte: new Date(Date.now() - 60 * 60 * 1000), // Last hour
            },
          },
        });

        const MAX_UPDATES_PER_HOUR = 10;
        if (recentUpdates >= MAX_UPDATES_PER_HOUR) {
          logger.warn(
            {
              did: actorDid,
              recentUpdates,
            },
            'Rate limit exceeded for profile updates'
          );
          reply.code(429).send({
            error: 'Too many requests',
            message: 'Profile update rate limit exceeded. Please try again later.',
          });
          return;
        }

        // Return immediately with 202 Accepted
        // Process the update asynchronously
        reply.code(202).send({
          status: 'accepted',
          message: 'Profile update notification received',
        });

        // Queue async profile update (non-blocking)
        processProfileUpdate(actorDid, updatedAt).catch((error) => {
          logger.error({ error, actorDid }, 'Failed to process profile update');
        });
      } catch (error) {
        logger.error({ error }, 'Failed to handle profile update notification');
        reply.code(500).send({
          error: 'Internal error',
          message: 'Failed to process profile update notification',
        });
      }
    }
  );

  /**
   * GET /trp/actors/:did/profile-status
   * Check the status of profile data for an actor
   * This is a utility endpoint for debugging
   */
  fastify.get<{
    Params: { did: string };
  }>(
    '/actors/:did/profile-status',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            did: { type: 'string' },
          },
          required: ['did'],
        },
        tags: ['profile-updates'],
        summary: 'Get profile status',
        description: 'Check the status of cached profile data for an actor',
      },
    },
    async (request, reply) => {
      try {
        const { did } = request.params;

        // Get actor info
        const actor = await prisma.actor.findUnique({
          where: { did },
          select: {
            name: true,
            metadata: true,
            lastSeenAt: true,
          },
        });

        if (!actor) {
          reply.code(404).send({
            error: 'Not found',
            message: 'Actor not found',
          });
          return;
        }

        // Get membership count
        const membershipCount = await prisma.membership.count({
          where: { actorDid: did },
        });

        // Get sample membership with profile data
        const sampleMembership = await prisma.membership.findFirst({
          where: { actorDid: did },
          select: {
            actorName: true,
            avatarUrl: true,
            profileUrl: true,
            instanceDomain: true,
            profileLastFetched: true,
            profileSource: true,
          },
        });

        reply.send({
          actorDid: did,
          actorName: actor.name,
          membershipCount,
          cachedProfile: sampleMembership || null,
          metadata: actor.metadata,
          lastSeenAt: actor.lastSeenAt.toISOString(),
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get profile status');
        reply.code(500).send({
          error: 'Internal error',
          message: 'Failed to retrieve profile status',
        });
      }
    }
  );
}

/**
 * Process profile update asynchronously
 * This runs in the background after returning 202 to the caller
 */
async function processProfileUpdate(actorDid: string, updatedAt: string): Promise<void> {
  try {
    logger.info({ did: actorDid, updatedAt }, 'Processing profile update');

    // Re-resolve DID document to get updated profile data
    const profile = await refreshActorProfile(actorDid);

    if (!profile) {
      logger.warn({ did: actorDid }, 'Failed to resolve updated profile');
      return;
    }

    // Update all memberships for this actor across all rings
    const updatedCount = await updateMembershipProfiles(actorDid, profile);

    logger.info(
      {
        did: actorDid,
        updatedCount,
        hasName: !!profile.actorName,
        hasAvatar: !!profile.avatarUrl,
      },
      'Profile update completed'
    );
  } catch (error) {
    logger.error({ error, actorDid }, 'Error processing profile update');
    throw error;
  }
}
