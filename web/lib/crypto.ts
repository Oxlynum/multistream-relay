import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'crypto'

/**
 * Constant-time string equality for comparing secrets/tokens/HMAC signatures — avoids the
 * timing side-channel of `===` (which short-circuits at the first differing byte). The length
 * fast-path leaks only length, which for our fixed-width tokens (HMAC hex, base64url SHA-256,
 * `Bearer <secret>`) reveals nothing about the content.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// AES-256-GCM envelope encryption for at-rest secrets (platform stream keys,
// and later any OAuth refresh tokens). The encryption key lives ONLY in
// STREAM_KEY_SECRET (Vercel env) — a different trust domain than Supabase — so
// a Supabase DB dump alone is ciphertext and useless without the Vercel secret.
//
// Stored format:  v1:<iv b64>:<authTag b64>:<ciphertext b64>
// GCM is authenticated: tampering with the ciphertext fails decryption.

const PREFIX = 'v1:'

// Normalize whatever STREAM_KEY_SECRET holds (random base64, hex, or a
// passphrase) to exactly 32 bytes via SHA-256, so key length is always valid.
function getKey(): Buffer {
  const raw = process.env.STREAM_KEY_SECRET
  if (!raw) throw new Error('STREAM_KEY_SECRET is not set — cannot encrypt/decrypt secrets')
  return createHash('sha256').update(raw).digest()
}

/** Encrypt a plaintext secret for storage. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

/**
 * Decrypt a stored secret. Values that aren't in the v1: envelope are returned
 * unchanged — this is the legacy-plaintext fallback so rows written before
 * encryption was enabled keep working until they're re-saved (and re-encrypted).
 */
export function decryptSecret(blob: string): string {
  if (!blob || !blob.startsWith(PREFIX)) return blob
  const [, ivB64, tagB64, ctB64] = blob.split(':')
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** True if a stored value is already in the encrypted envelope. */
export function isEncrypted(blob: string): boolean {
  return !!blob && blob.startsWith(PREFIX)
}
