// Runs every tests/**/*.test.js with node:test. Passes explicit file paths because
// glob/directory handling of `node --test` differs between Node 20 and newer.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return collect(p);
    return e.name.endsWith('.test.js') ? [p] : [];
  });
}

const files = collect('tests');
const env = { ...process.env, NODE_ENV: 'test', AI_MODE: 'mock' };
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exit(res.status ?? 1);
