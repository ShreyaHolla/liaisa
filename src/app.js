import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { publicRoutes } from './routes/public.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(config) {
  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, 'views'));
  app.disable('x-powered-by');

  app.use(helmet());
  app.use('/css', express.static(path.join(here, 'public', 'css')));
  app.use(publicRoutes(config));

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  return app;
}
