// Pre-flight for `npm run package`: what is under src/public, and is anything essential missing?
import fs from 'node:fs';
import path from 'node:path';

export const REQUIRED_CSS = 'css/app.css';

function walk(dir, base) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [{ rel: path.relative(base, full).split(path.sep).join('/'), size: fs.statSync(full).size }];
  });
}

/** Files under `publicDir` (the ones the zip will carry), sorted. Ignores .DS_Store like the zip does. */
export const listPublicFiles = (publicDir) => walk(publicDir, publicDir).filter((f) => !f.rel.endsWith('.DS_Store')).sort((a, b) => a.rel.localeCompare(b.rel));

/**
 * Throws if the main stylesheet is missing or empty, or there is no font file.
 * Returns the file list so the caller can print it.
 */
export function checkPublicAssets(publicDir) {
  const files = listPublicFiles(publicDir);
  const css = files.find((f) => f.rel === REQUIRED_CSS);
  if (!css || css.size === 0) throw new Error(`Missing or empty ${REQUIRED_CSS} in ${publicDir}. The site would have no styles.`);
  if (!files.some((f) => /^fonts\/.+\.woff2$/.test(f.rel))) throw new Error(`No .woff2 font file under ${publicDir}/fonts. Pages would fall back to system fonts.`);
  return files;
}
