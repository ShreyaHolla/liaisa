import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { publicRoutes } from './routes/public.js';
import { contactRoutes } from './routes/contact.js';
import { enquiryRoutes } from './routes/enquiries.js';
import { quoteRoutes } from './routes/quotes.js';
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

  // form-action must allow wa.me: the owner's "Send on WhatsApp" form POST redirects there (F12).
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'form-action': ["'self'", 'https://wa.me'] },
    },
  }));
  app.use('/css', express.static(path.join(here, 'public', 'css')));
  app.use('/js', express.static(path.join(here, 'public', 'js')));
  app.use(publicRoutes(config));
  app.use(contactRoutes({ store: deps.contacts, mailer: deps.mailer, config }));
  app.use(enquiryRoutes({ repos: deps.repos, ai: deps.ai, config, mailer: deps.mailer }));
  app.use(quoteRoutes({ repos: deps.repos, config, mailer: deps.mailer }));
  app.use('/owner', config.ownerEnabled ? ownerRoutes({ config, repos: deps.repos, mailer: deps.mailer }) : ownerDisabled);

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use(errorHandler);
  return app;
}
