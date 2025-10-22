import { logger } from '../utils/logger';
import { resolveDID, DIDDocument } from '../security/did-resolver';
import { prisma } from '../database/prisma';

/**
 * Actor profile data extracted from DID document
 */
export interface ActorProfile {
  actorDid: string;
  actorName: string | null;      // From didDoc.name (Tier 2 - conditional on privacy)
  avatarUrl: string | null;       // From didDoc.image (Tier 2 - conditional on privacy)
  profileUrl: string;             // From didDoc.service[type=Profile] (Tier 1 - REQUIRED)
  handle: string | null;          // Extracted from profile URL (e.g., "annabelle" from /resident/annabelle)
  instanceDomain: string | null;  // Parsed from DID for federation UX
}

/**
 * Extract instance domain from DID
 * Example: did:web:example.com:users:abc123 -> example.com
 */
function extractDomainFromDID(did: string): string | null {
  try {
    if (!did.startsWith('did:web:')) {
      return null;
    }

    // Parse did:web:DOMAIN:... format
    const parts = did.split(':');
    if (parts.length < 3) {
      return null;
    }

    // Domain is the third part (index 2), after 'did' and 'web'
    const domain = parts[2].replace(/%3A/g, ':'); // Decode encoded colons (for ports)
    return domain;
  } catch (error) {
    logger.error({ error, did }, 'Failed to extract domain from DID');
    return null;
  }
}

/**
 * Extract handle from profile URL
 * Example: https://homepageagain.com/resident/annabelle -> "annabelle"
 */
function extractHandleFromProfileUrl(profileUrl: string): string | null {
  try {
    const url = new URL(profileUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Profile URLs are typically: /resident/{handle} or /u/{handle} or /@{handle}
    if (pathParts.length >= 2) {
      const handle = pathParts[pathParts.length - 1];
      // Remove @ prefix if present
      return handle.startsWith('@') ? handle.substring(1) : handle;
    }

    return null;
  } catch (error) {
    logger.warn({ error, profileUrl }, 'Failed to extract handle from profile URL');
    return null;
  }
}

/**
 * Extract profile URL from DID document service endpoints
 * Looks for service with type "Profile" and extracts serviceEndpoint
 */
function extractProfileUrl(didDoc: DIDDocument): string | null {
  try {
    if (!didDoc.service || didDoc.service.length === 0) {
      return null;
    }

    // Find Profile service endpoint (Tier 1 requirement)
    const profileService = didDoc.service.find(
      (s) => s.type === 'Profile' || s.type === 'profile'
    );

    if (!profileService?.serviceEndpoint) {
      return null;
    }

    // Validate it's a proper HTTPS URL
    const url = profileService.serviceEndpoint;
    if (!url.startsWith('https://') && !url.startsWith('http://localhost')) {
      logger.warn({ url, did: didDoc.id }, 'Profile URL is not HTTPS');
      return null;
    }

    return url;
  } catch (error) {
    logger.error({ error, did: didDoc.id }, 'Failed to extract profile URL from DID document');
    return null;
  }
}

/**
 * Extract complete actor profile from DID document
 */
export function extractProfileFromDID(didDoc: DIDDocument): ActorProfile | null {
  try {
    const actorDid = didDoc.id;

    // Extract profile URL (REQUIRED - Tier 1)
    const profileUrl = extractProfileUrl(didDoc);
    if (!profileUrl) {
      logger.warn({ did: actorDid }, 'DID document missing required Profile service endpoint');
      return null;
    }

    // Extract domain from DID
    const instanceDomain = extractDomainFromDID(actorDid);

    // Extract handle from profile URL
    const handle = extractHandleFromProfileUrl(profileUrl);

    // Extract optional profile data (Tier 2 - conditional on privacy settings)
    const actorName = didDoc.name || null;
    const avatarUrl = didDoc.image || null;

    const profile: ActorProfile = {
      actorDid,
      actorName,
      avatarUrl,
      profileUrl,
      handle,
      instanceDomain,
    };

    logger.info(
      {
        did: actorDid,
        hasName: !!actorName,
        hasAvatar: !!avatarUrl,
        profileUrl,
        handle,
        instanceDomain,
      },
      'Extracted profile from DID document'
    );

    return profile;
  } catch (error) {
    logger.error({ error, did: didDoc.id }, 'Failed to extract profile from DID document');
    return null;
  }
}

/**
 * Validate that a DID document meets federation requirements
 */
export function validateProfileServiceEndpoint(didDoc: DIDDocument): {
  valid: boolean;
  error?: string;
} {
  try {
    // Check for required Profile service endpoint
    const profileUrl = extractProfileUrl(didDoc);

    if (!profileUrl) {
      return {
        valid: false,
        error:
          'Your instance must provide a Profile service endpoint in your DID document to join federated ThreadRings. Please ensure your DID document includes a service with type "Profile".',
      };
    }

    // Validate URL format
    try {
      new URL(profileUrl);
    } catch {
      return {
        valid: false,
        error: `Invalid profile URL format: ${profileUrl}`,
      };
    }

    return { valid: true };
  } catch (error) {
    logger.error({ error, did: didDoc.id }, 'Failed to validate DID document');
    return {
      valid: false,
      error: 'Failed to validate DID document structure',
    };
  }
}

/**
 * Check if profile cache is stale (older than 24 hours)
 */
export function shouldRefreshProfile(profileLastFetched: Date | null): boolean {
  if (!profileLastFetched) {
    return true; // Never fetched, needs refresh
  }

  const cacheMaxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  const age = Date.now() - profileLastFetched.getTime();

  return age > cacheMaxAge;
}

/**
 * Resolve actor profile with caching
 * Returns cached data if fresh, otherwise re-resolves DID document
 */
export async function resolveActorProfile(
  actorDid: string,
  forceRefresh = false
): Promise<ActorProfile | null> {
  try {
    // If not forcing refresh, check if we have fresh cached data in Actor table
    if (!forceRefresh) {
      const actor = await prisma.actor.findUnique({
        where: { did: actorDid },
        select: {
          name: true,
          metadata: true,
          discoveredAt: true,
        },
      });

      // Check if we have profile data in metadata and it's fresh
      if (actor?.metadata && typeof actor.metadata === 'object') {
        const metadata = actor.metadata as any;
        if (
          metadata.profileUrl &&
          metadata.profileLastFetched &&
          !shouldRefreshProfile(new Date(metadata.profileLastFetched))
        ) {
          logger.info({ did: actorDid }, 'Using cached profile data from Actor table');
          return {
            actorDid,
            actorName: metadata.actorName || actor.name || null,
            avatarUrl: metadata.avatarUrl || null,
            profileUrl: metadata.profileUrl,
            instanceDomain: metadata.instanceDomain || null,
          };
        }
      }
    }

    // Resolve DID document
    logger.info({ did: actorDid, forceRefresh }, 'Resolving DID document for profile data');
    const didDoc = await resolveDID(actorDid);

    if (!didDoc) {
      logger.warn({ did: actorDid }, 'Failed to resolve DID document');
      return null;
    }

    // Extract profile from DID document
    const profile = extractProfileFromDID(didDoc);

    if (!profile) {
      logger.warn({ did: actorDid }, 'Failed to extract profile from DID document');
      return null;
    }

    // Cache profile data in Actor table metadata
    await prisma.actor.upsert({
      where: { did: actorDid },
      update: {
        name: profile.actorName,
        metadata: {
          actorName: profile.actorName,
          avatarUrl: profile.avatarUrl,
          profileUrl: profile.profileUrl,
          instanceDomain: profile.instanceDomain,
          profileLastFetched: new Date().toISOString(),
        },
        lastSeenAt: new Date(),
      },
      create: {
        did: actorDid,
        name: profile.actorName,
        type: 'USER',
        instanceUrl: profile.profileUrl,
        metadata: {
          actorName: profile.actorName,
          avatarUrl: profile.avatarUrl,
          profileUrl: profile.profileUrl,
          instanceDomain: profile.instanceDomain,
          profileLastFetched: new Date().toISOString(),
        },
        verified: true,
        trusted: false,
      },
    });

    logger.info({ did: actorDid }, 'Profile data cached in Actor table');

    return profile;
  } catch (error) {
    logger.error({ error, actorDid }, 'Failed to resolve actor profile');
    return null;
  }
}

/**
 * Refresh actor profile (force re-resolution)
 * Used when receiving profile update notifications from ThreadStead
 */
export async function refreshActorProfile(actorDid: string): Promise<ActorProfile | null> {
  logger.info({ did: actorDid }, 'Forcing profile refresh');
  return resolveActorProfile(actorDid, true);
}

/**
 * Update all memberships for an actor with new profile data
 * Called after receiving profile update notification
 */
export async function updateMembershipProfiles(
  actorDid: string,
  profile: ActorProfile
): Promise<number> {
  try {
    const result = await prisma.membership.updateMany({
      where: { actorDid },
      data: {
        actorName: profile.actorName,
        avatarUrl: profile.avatarUrl,
        profileUrl: profile.profileUrl,
        instanceDomain: profile.instanceDomain,
        profileLastFetched: new Date(),
        profileSource: 'DID_RESOLUTION',
      },
    });

    logger.info(
      {
        did: actorDid,
        updatedCount: result.count,
      },
      'Updated membership profiles across all rings'
    );

    return result.count;
  } catch (error) {
    logger.error({ error, actorDid }, 'Failed to update membership profiles');
    return 0;
  }
}
