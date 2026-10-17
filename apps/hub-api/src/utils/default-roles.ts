import type { Prisma, PrismaClient, RingRole } from '@prisma/client';

/**
 * Roles every new ring starts with — shared by POST /trp/rings, POST /trp/fork
 * and the integration seed so they can't drift apart again.
 *
 * `moderator` deliberately lacks `manage_members`: PUT /rings/:slug/members/:did
 * lets any manage_members holder assign ANY role in the ring, including owner.
 */
export const DEFAULT_ROLES = [
  {
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
  {
    name: 'moderator',
    permissions: ['moderate_posts', 'submit_posts', 'view_content'],
  },
  {
    name: 'member',
    permissions: ['submit_posts', 'view_content'],
  },
] as const;

export type DefaultRoleName = (typeof DEFAULT_ROLES)[number]['name'];

/** Create the default roles for a new ring and return the owner role. */
export async function createDefaultRoles(
  db: PrismaClient | Prisma.TransactionClient,
  ringId: string
): Promise<RingRole> {
  const roles = await Promise.all(
    DEFAULT_ROLES.map((role) =>
      db.ringRole.create({
        data: { ringId, name: role.name, permissions: [...role.permissions] },
      })
    )
  );
  return roles.find((role) => role.name === 'owner')!;
}
