// Builds liaisa-<git short sha>.zip for GoDaddy. Includes only what the host needs.
// Excludes .env*, node_modules, tests, docs, coverage and zips. Keeps the last 3 zips.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const INCLUDE = ['package.json', 'package-lock.json', 'src', 'prompts', 'db/migrations'];

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
