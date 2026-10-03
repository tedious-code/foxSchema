import { randomBytes, scrypt, timingSafeEqual, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

/**
 * Password hashing (scrypt, built into Node — no native dep) and AES-256-GCM
 * encryption for stored DB credentials.
 *
 * The raw key material (DEK) comes from APP_ENCRYPTION_KEY. On desktop the DEK
 * lives in the OS keychain (never on disk) and is bound to the user's email, so
 * a copied database can't be decrypted on another machine. Two key schemes:
 *   - v1 (legacy / migrated installs): AES key = the DEK directly.
 *   - v2 (new, email-bound):           AES key = HKDF(DEK, salt=email).
 * Each ciphertext is tagged with its scheme ("v1:" / "v2:" prefix) so both
 * remain decryptable; untagged payloads are treated as legacy v1.
 */

const SCRYPT_KEYLEN = 64;

type KeyScheme = 'v1' | 'v2';

/**
 * scrypt on libuv's thread pool. The synchronous form held the event loop for
 * each hash, so a burst of sign-in attempts stalled every other request,
 * migration streams included.
 */
function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

let warnedInsecureKey = false;

/** Raw 32-byte key material from APP_ENCRYPTION_KEY (the keychain-held DEK). */
function getDek(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (raw) {
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('APP_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64-encoded).');
    }
    return key;
  }

  // Strict in production; in dev fall back to an INSECURE fixed key so the app
  // runs out of the box. (Matches the all-zero default in the dev:api script,
  // so credentials saved either way stay mutually decryptable.)
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_ENCRYPTION_KEY is not set — required to encrypt stored database credentials in production.');
  }
  if (!warnedInsecureKey) {
    console.warn('[crypto] APP_ENCRYPTION_KEY not set — using an INSECURE development key. Set a real 32-byte key before production.');
    warnedInsecureKey = true;
  }
  return Buffer.alloc(32, 0);
}

/** Normalized email the key is bound to (v2), or '' if none. */
function boundEmail(): string {
  return (process.env.APP_USER_EMAIL || '').trim().toLowerCase();
}

/** The scheme used for NEW encryptions: v2 (email-bound) when an email is set. */
function activeScheme(): KeyScheme {
  const forced = process.env.APP_KEY_SCHEME;
  if (forced === 'v1' || forced === 'v2') return forced;
  return boundEmail() ? 'v2' : 'v1';
}

/** Derives the AES key for a given scheme. v2 binds the DEK to the email. */
function deriveKey(scheme: KeyScheme): Buffer {
  const dek = getDek();
  if (scheme === 'v1') return dek;
  const email = boundEmail();
  if (!email) {
    throw new Error('APP_USER_EMAIL is required for the email-bound (v2) key scheme.');
  }
  const salt = Buffer.from(`foxschema:${email}`, 'utf8');
  const info = Buffer.from('foxschema-credential-key', 'utf8');
  return Buffer.from(hkdfSync('sha256', dek, salt, info, 32));
}

/** Non-secret info about the active key scheme, for display in the UI. */
export function keySchemeInfo(): { scheme: KeyScheme; emailBound: boolean; boundEmail: string } {
  const scheme = activeScheme();
  const email = boundEmail();
  return { scheme, emailBound: scheme === 'v2' && !!email, boundEmail: scheme === 'v2' ? email : '' };
}

/** Encrypts a secret to "scheme:iv:authTag:ciphertext" (iv/tag/data base64). */
export function encryptSecret(plaintext: string): string {
  const scheme = activeScheme();
  const iv = randomBytes(12); // GCM standard nonce size
  const cipher = createCipheriv('aes-256-gcm', deriveKey(scheme), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${scheme}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  let scheme: KeyScheme = 'v1';
  let ivB64: string | undefined, tagB64: string | undefined, dataB64: string | undefined;
  if (parts.length === 4 && (parts[0] === 'v1' || parts[0] === 'v2')) {
    scheme = parts[0] as KeyScheme;
    [, ivB64, tagB64, dataB64] = parts;
  } else if (parts.length === 3) {
    // Legacy untagged payload, encrypted before scheme tags existed → v1.
    [ivB64, tagB64, dataB64] = parts;
  }
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted payload.');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(scheme), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Opaque session token. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
