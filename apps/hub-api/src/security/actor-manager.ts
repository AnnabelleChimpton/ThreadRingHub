import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { resolveDID, extractPublicKey } from './did-resolver';
import { ActorType } from '@prisma/client';

export interface ActorRegistration {
  did: string;
  name?: string;
  type: ActorType;
  instanceUrl?: string;
  publicKey?: string;
}

export interface ActorInfo {
  id: string;
  did: string;
  name: string | null;
  type: ActorType;
  instanceUrl: string | null;
  verified: boolean;
  trusted: boolean;
  lastSeenAt: Date;
}

/**
 * Register a new actor in the system
 */
export async function registerActor(
  registration: ActorRegistration
): Promise<ActorInfo | null> {
  try {
    // Check if actor already exists
    const existing = await prisma.actor.findUnique({
      where: { did: registration.did },
    });

    if (existing) {
      // Update last seen and return existing actor
      const updated = await prisma.actor.update({
        where: { did: registration.did },
        data: { lastSeenAt: new Date() },
      });
      
      return {
        id: updated.id,
        did: updated.did,
        name: updated.name,
        type: updated.type,
        instanceUrl: updated.instanceUrl,
        verified: updated.verified,
        trusted: updated.trusted,
        lastSeenAt: updated.lastSeenAt,
      };
    }

    // Resolve DID to get verification info
    const didDocument = await resolveDID(registration.did);
    let verified = false;
    let publicKey = registration.publicKey;

    if (didDocument) {
      verified = true;
      if (!publicKey) {
        publicKey = extractPublicKey(didDocument);
      }
    }

    // Create new actor
    const actor = await prisma.actor.create({
      data: {
        did: registration.did,
        name: registration.name,
        type: registration.type,
        instanceUrl: registration.instanceUrl,
        publicKey,
        verified,
        trusted: false, // Trust must be explicitly granted
        discoveredAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    logger.info({ 
      did: registration.did, 
      verified 
    }, 'Actor registered');

    return {
      id: actor.id,
      did: actor.did,
      name: actor.name,
      type: actor.type,
      instanceUrl: actor.instanceUrl,
      verified: actor.verified,
      trusted: actor.trusted,
      lastSeenAt: actor.lastSeenAt,
    };
  } catch (error) {
    logger.error({ error, registration }, 'Failed to register actor');
    return null;
  }
}

/**
 * Get actor information by DID
 */
export async function getActor(did: string): Promise<ActorInfo | null> {
  try {
    const actor = await prisma.actor.findUnique({
      where: { did },
    });

    if (!actor) {
      return null;
    }

    // Update last seen
    await prisma.actor.update({
      where: { did },
      data: { lastSeenAt: new Date() },
    });

    return {
      id: actor.id,
      did: actor.did,
      name: actor.name,
      type: actor.type,
      instanceUrl: actor.instanceUrl,
      verified: actor.verified,
      trusted: actor.trusted,
      lastSeenAt: actor.lastSeenAt,
    };
  } catch (error) {
    logger.error({ error, did }, 'Failed to get actor');
    return null;
  }
}

/**
 * Verify an actor's DID and update verification status
 */
export async function verifyActor(did: string): Promise<boolean> {
  try {
    const didDocument = await resolveDID(did);
    const verified = !!didDocument;

    await prisma.actor.update({
      where: { did },
      data: { 
        verified,
        lastSeenAt: new Date(),
      },
    });

    logger.info({ did, verified }, 'Actor verification updated');
    return verified;
  } catch (error) {
    logger.error({ error, did }, 'Failed to verify actor');
    return false;
  }
}

/**
 * Update actor trust level
 */
export async function setActorTrust(
  did: string,
  trusted: boolean,
  trustedBy: string
): Promise<boolean> {
  try {
    await prisma.actor.update({
      where: { did },
      data: { trusted },
    });

    // Log the trust change
    logger.info({ 
      actorDid: did, 
      trusted, 
      trustedBy 
    }, 'Actor trust level updated');

    return true;
  } catch (error) {
    logger.error({ error, did, trusted }, 'Failed to update actor trust');
    return false;
  }
}

/**
 * Register a public key for an actor
 */
export async function registerActorKey(
  actorDid: string,
  keyId: string,
  publicKey: string
): Promise<boolean> {
  try {
    // Verify the actor owns this key by checking their DID document
    const didDocument = await resolveDID(actorDid);
    if (!didDocument) {
      logger.warn({ actorDid, keyId }, 'Cannot verify key ownership - DID not resolvable');
      return false;
    }

    // Check if the key is in the DID document
    const keyExists = didDocument.verificationMethod?.some(vm => 
      vm.id === keyId || vm.id.endsWith(`#${keyId}`)
    );

    if (!keyExists) {
      logger.warn({ actorDid, keyId }, 'Key not found in DID document');
      return false;
    }

    // Store the key
    await prisma.httpSignature.upsert({
      where: { keyId },
      update: {
        publicKey,
        actorDid,
        lastUsed: new Date(),
      },
      create: {
        keyId,
        publicKey,
        actorDid,
        trusted: false, // Keys start untrusted
      },
    });

    logger.info({ actorDid, keyId }, 'Actor key registered');
    return true;
  } catch (error) {
    logger.error({ error, actorDid, keyId }, 'Failed to register actor key');
    return false;
  }
}

/**
 * Get all actors with pagination
 */
export async function listActors(options: {
  limit?: number;
  offset?: number;
  verified?: boolean;
  trusted?: boolean;
  type?: ActorType;
}): Promise<ActorInfo[]> {
  try {
    const actors = await prisma.actor.findMany({
      where: {
        verified: options.verified,
        trusted: options.trusted,
        type: options.type,
      },
      take: options.limit || 50,
      skip: options.offset || 0,
      orderBy: { lastSeenAt: 'desc' },
    });

    return actors.map(actor => ({
      id: actor.id,
      did: actor.did,
      name: actor.name,
      type: actor.type,
      instanceUrl: actor.instanceUrl,
      verified: actor.verified,
      trusted: actor.trusted,
      lastSeenAt: actor.lastSeenAt,
    }));
  } catch (error) {
    logger.error({ error }, 'Failed to list actors');
    return [];
  }
}

/**
 * Check if an actor is blocked in a specific ring
 */
export async function isActorBlocked(
  actorDid: string,
  ringId: string
): Promise<boolean> {
  try {
    const block = await prisma.block.findFirst({
      where: {
        ringId,
        targetDid: actorDid,
      },
    });

    return !!block;
  } catch (error) {
    logger.error({ error, actorDid, ringId }, 'Failed to check if actor is blocked');
    return false;
  }
}

/**
 * Block an actor in a specific ring
 */
export async function blockActor(
  actorDid: string,
  ringId: string,
  blockedBy: string,
  reason?: string
): Promise<boolean> {
  try {
    await prisma.block.create({
      data: {
        ringId,
        targetDid: actorDid,
        targetType: 'USER',
        blockedBy,
        reason,
        blockedAt: new Date(),
      },
    });

    logger.info({ 
      actorDid, 
      ringId, 
      blockedBy, 
      reason 
    }, 'Actor blocked');

    return true;
  } catch (error) {
    logger.error({ error, actorDid, ringId }, 'Failed to block actor');
    return false;
  }
}

/**
 * Unblock an actor in a specific ring
 */
export async function unblockActor(
  actorDid: string,
  ringId: string
): Promise<boolean> {
  try {
    await prisma.block.delete({
      where: {
        ringId_targetDid: {
          ringId,
          targetDid: actorDid,
        },
      },
    });

    logger.info({ actorDid, ringId }, 'Actor unblocked');
    return true;
  } catch (error) {
    logger.error({ error, actorDid, ringId }, 'Failed to unblock actor');
    return false;
  }
}