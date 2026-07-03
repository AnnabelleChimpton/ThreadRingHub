import crypto from 'crypto';
import { config } from '../config';
import { logger } from './logger';

/**
 * Central loader for the Ring Hub badge-signing key.
 *
 * The persistent key is provided via the RING_HUB_PRIVATE_KEY environment
 * variable as the BASE64 ENCODING OF A PKCS#8 PEM Ed25519 private key. That is:
 *
 *   RING_HUB_PRIVATE_KEY = base64( "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n" )
 *
 * Buffer.from(value, 'base64') yields the PEM text bytes, and
 * crypto.createPrivateKey(buffer) parses a bare Buffer as PEM.
 *
 * When no valid key is configured we fall back to an ephemeral in-memory key so
 * that rings keep serving, but we flag that state loudly: any badge signed with
 * an ephemeral key is PERMANENTLY INVALID after the next restart (verification
 * would use a different, freshly generated public key).
 */

let ringHubPrivateKey: crypto.KeyObject;
let usingEphemeralKey = false;

if (config.security.privateKey) {
  try {
    const privateKeyBuffer = Buffer.from(config.security.privateKey, 'base64');
    ringHubPrivateKey = crypto.createPrivateKey(privateKeyBuffer);
    logger.info('Loaded persistent RING_HUB_PRIVATE_KEY from configuration');
  } catch (error) {
    usingEphemeralKey = true;
    logger.error(
      { error },
      'RING_HUB_PRIVATE_KEY is set but FAILED TO LOAD (expected base64 of a PKCS#8 PEM Ed25519 key). ' +
        'Falling back to an EPHEMERAL in-memory key. Every badge signed this boot will become INVALID after the next restart. ' +
        'Fix RING_HUB_PRIVATE_KEY and restart.'
    );
    ringHubPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey;
  }
} else {
  usingEphemeralKey = true;
  logger.error(
    'RING_HUB_PRIVATE_KEY is NOT configured. Using an EPHEMERAL in-memory signing key. ' +
      'CONSEQUENCE: every membership badge signed this boot will be PERMANENTLY INVALID after the next restart ' +
      '(verification will use a different public key). Rings will keep serving, but badge issuance is unsafe. ' +
      'Set RING_HUB_PRIVATE_KEY to a base64-encoded PKCS#8 PEM Ed25519 key to fix this.'
  );
  ringHubPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey;
}

/** The active Ed25519 signing key (persistent when configured, else ephemeral). */
export const RING_HUB_PRIVATE_KEY: crypto.KeyObject = ringHubPrivateKey;

/** True when the signing key is ephemeral (unset or failed to load). */
export const USING_EPHEMERAL_KEY = usingEphemeralKey;

/**
 * In production we refuse to issue badges that we know will break on the next
 * restart. Returns an error message string when issuance must be blocked,
 * otherwise null (issuance allowed).
 */
export function ephemeralBadgeIssuanceBlock(): string | null {
  if (USING_EPHEMERAL_KEY && config.env === 'production') {
    return (
      'Badge issuance is disabled: the hub is running with an ephemeral signing key ' +
      '(RING_HUB_PRIVATE_KEY is unset or invalid). Configure a persistent key and restart.'
    );
  }
  return null;
}
