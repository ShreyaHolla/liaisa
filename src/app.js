import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { publicRoutes } from './routes/public.js';
import { contactRoutes } from './routes/contact.js';
import { enquiryRoutes } from './routes/enquiries.js';
import { quoteRoutes } from './routes/quotes.js';
import { oneTapRoutes } from './routes/oneTap.js';
import { ownerRoutes, ownerDisabled } from './routes/owner.js';
import { errorHandler } from './middleware/errors.js';
import { buildDeps } from './container.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `deps` ({ contacts, repos, mailer, ai }) lets tests inject a fake mailer; default wires by env. */
export function createApp(config, deps = buildDeps(config)) {
  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, 'views'));
  app.disable('x-powered-by');
  // Owner navigation (bottom tab bar on phones, sidebar on desktop). Icons are inline SVG paths: no external assets.
  app.locals.ownerNav = [
    { key: 'approvals', href: '/owner', label: 'Approvals', icon: '<path d="M4 12.5l5 5L20 6.5"/>' },
    { key: 'clients', href: '/owner/clients', label: 'Clients', icon: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16.5 5.2a3.2 3.2 0 010 5.6M18 14c1.8.7 3 2.2 3 4.5"/>' },
    { key: 'followups', href: '/owner/follow-ups', label: 'Follow-ups', icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 6.5V12l3.5 2"/>' },
    { key: 'setup', href: '/owner/setup', label: 'Setup', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>' },
  ];

  // form-action must allow wa.me and the hosts it redirects to: Chrome checks the whole redirect
  // chain for the owner's "Send on WhatsApp" form POST (F12).
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'form-action': ["'self'", 'https://wa.me', 'https://api.whatsapp.com', 'https://web.whatsapp.com'] },
    },
  }));
  app.use('/css', express.static(path.join(here, 'public', 'css')));
  app.use('/js', express.static(path.join(here, 'public', 'js')));
  app.use('/fonts', express.static(path.join(here, 'public', 'fonts'), { maxAge: '30d', immutable: true }));
  app.use(publicRoutes(config));
  app.use(contactRoutes({ store: deps.contacts, mailer: deps.mailer, config }));
  app.use(enquiryRoutes({ repos: deps.repos, ai: deps.ai, config, mailer: deps.mailer }));
  app.use(quoteRoutes({ repos: deps.repos, config, mailer: deps.mailer }));
  app.use(oneTapRoutes({ repos: deps.repos, config, mailer: deps.mailer }));
  app.use('/owner', config.ownerEnabled ? ownerRoutes({ config, repos: deps.repos, mailer: deps.mailer, ai: deps.ai }) : ownerDisabled);

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use(errorHandler);
  return app;
}
