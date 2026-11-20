import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** 26-char ULID: 10 chars of time (sortable) + 16 random. Used as enquiries.public_id. */
export function ulid(now = Date.now()) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ALPHABET[rnd[i] % 32];
  return time + tail;
}
