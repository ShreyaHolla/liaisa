import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

export function publicRoutes() {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('pages/home');
  });

  // No DB until M4, so db is always false for now. Always 200 (see openapi.yaml).
  router.get('/healthz', (req, res) => {
    res.json({ ok: true, db: false, version });
  });

  return router;
}
