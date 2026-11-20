// Cache-busting for static assets. Every file under src/public gets a short content hash at startup, and views link
// it as /css/app.css?v=<hash>. A new deploy changes the content, so the hash and the URL change, and browsers
// (and CDNs) fetch the new file even though the old URL was cached "immutable".
// URLs are root-relative paths only: nothing is built from the request's protocol or host.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';
const FONT_URL = /url\((['"]?)(\/fonts\/[^'")?]+)\1\)/g;

const shortHash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [{ file: full, url: `/${path.relative(base, full).split(path.sep).join('/')}` }];
  });
}

/**
 * Hash every file in `publicDir`. The CSS is served after rewriting its /fonts/ URLs to carry each font's hash,
 * so a changed font also changes the stylesheet's own hash.
 * Returns { asset(url) -> 'url?v=hash', hashes: Map(url -> hash), css: Map(url -> processed text), files }.
 */
export function buildAssets(publicDir) {
  const files = walk(publicDir);
  const hashes = new Map();
  const css = new Map();
  for (const { file, url } of files) if (!url.endsWith('.css')) hashes.set(url, shortHash(fs.readFileSync(file)));
  for (const { file, url } of files) {
    if (!url.endsWith('.css')) continue;
    const text = fs.readFileSync(file, 'utf8').replace(FONT_URL, (m, q, u) => (hashes.has(u) ? `url(${q}${u}?v=${hashes.get(u)}${q})` : m));
    css.set(url, text);
    hashes.set(url, shortHash(text));
  }
  return {
    files: files.map((f) => f.url).sort(),
    hashes, css,
    /** '/css/app.css' -> '/css/app.css?v=3fa9c2b1d0'. Unknown files come back unchanged. */
    asset: (url) => (hashes.has(url) ? `${url}?v=${hashes.get(url)}` : url),
  };
}

/** Cache-Control for a static file: immutable when asked for with a version, otherwise revalidate. */
export const cacheControlFor = (req) => (typeof req.query.v === 'string' && req.query.v !== '' ? IMMUTABLE : REVALIDATE);
