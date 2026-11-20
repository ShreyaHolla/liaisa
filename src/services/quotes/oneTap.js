// Signed one-tap Approve / Decline links for the owner notice email (M12).
// Token = base64url(payload) "." base64url(HMAC-SHA256). The key is derived from SESSION_SECRET (no new secret).
// Valid for 24 hours, usable once. A link only ever opens a confirm page: the action needs a POST with CSRF.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const LINK_HOURS = 24;
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const keyFor = (secret) => createHmac('sha256', secret).update('liaisa:one-tap-links:v1').digest();
const mac = (secret, body) => createHmac('sha256', keyFor(secret)).update(body).digest();

/** @param {{ enquiryId: number, version: number, action: 'approve'|'decline' }} p */
export function signLink(secret, { enquiryId, version, action }, now = new Date()) {
  const body = b64(JSON.stringify({ e: enquiryId, v: version, a: action, x: now.getTime() + LINK_HOURS * 3600 * 1000, n: b64(randomBytes(12)) }));
  return `${body}.${b64(mac(secret, body))}`;
}

/** { ok: true, payload } or { ok: false, reason: 'malformed' | 'tampered' | 'expired' } */
export function verifyLink(secret, token, now = new Date()) {
  if (typeof token !== 'string' || token.length > 400 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: 'malformed' };
  const [body, sig] = token.split('.');
  const want = mac(secret, body);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'tampered' };
  let p;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!Number.isInteger(p.e) || !Number.isInteger(p.v) || !['approve', 'decline'].includes(p.a) || typeof p.n !== 'string' || !Number.isFinite(p.x)) return { ok: false, reason: 'malformed' };
  if (now.getTime() >= p.x) return { ok: false, reason: 'expired' };
  return { ok: true, payload: { enquiryId: p.e, version: p.v, action: p.a, nonce: p.n, expires: new Date(p.x) } };
}
