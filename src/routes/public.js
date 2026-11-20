import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// One-line messages for the no-JS contact fallback (?contact=...). Unknown values show nothing.
const CONTACT_NOTICES = {
  sent: { tone: 'ok', text: "Thanks, we got your message. We'll reply by email." },
  error: { tone: 'error', text: 'Check your name, email and message, then send it again.' },
  limit: { tone: 'error', text: "You've sent a few messages in a row. Try again in an hour." },
};

export function publicRoutes() {
  const router = Router();

  router.get('/', (req, res) => {
    const key = typeof req.query.contact === 'string' ? req.query.contact : '';
    const contactNotice = Object.hasOwn(CONTACT_NOTICES, key) ? CONTACT_NOTICES[key] : null;
    res.render('pages/home', { contactNotice });
  });

  // No DB until M4, so db is always false for now. Always 200 (see openapi.yaml).
  router.get('/healthz', (req, res) => {
    res.json({ ok: true, db: false, version });
  });

  return router;
}
