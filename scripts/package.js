// Builds liaisa-<git short sha>.zip for GoDaddy. Includes only what the host needs.
// Excludes .env*, node_modules, tests, docs, coverage and zips. Keeps the last 3 zips.
// Prints every file under src/public it includes, and fails if css/app.css or a font is missing.
// `node scripts/package.js --check` only does that check.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkPublicAssets } from './lib/checkAssets.js';

const INCLUDE = ['package.json', 'package-lock.json', 'src', 'prompts', 'db/migrations'];

// Static assets: list what goes in, and refuse to build a zip without the stylesheet or a font.
try {
  const files = checkPublicAssets('src/public');
  console.log(`Files under src/public included (${files.length}):`);
  for (const f of files) console.log(`  ${f.rel} (${f.size} bytes)`);
} catch (err) {
  console.error(`Package aborted: ${err.message}`);
  process.exit(1);
}
if (process.argv.includes('--check')) process.exit(0); // list and verify only, no zip

const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
const name = `liaisa-${sha}.zip`;

const items = INCLUDE.filter((p) => fs.existsSync(p));
fs.rmSync(name, { force: true });
execFileSync('zip', ['-r', '-q', name, ...items, '-x', '*.DS_Store', '-x', '*/.env*'], { stdio: 'inherit' });
console.log(`Built ${name} (${items.join(', ')})`);
if (dirty) console.warn('Warning: working tree has uncommitted changes; the zip may not match the sha.');

const zips = fs
  .readdirSync('.')
  .filter((f) => /^liaisa-.+\.zip$/.test(f))
  .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
  .sort((a, b) => b.t - a.t);
for (const { f } of zips.slice(3)) {
  fs.rmSync(f);
  console.log(`Removed old ${f}`);
}
