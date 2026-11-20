import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createRepos } from '../../src/container.js';
import { seed } from '../../src/seed.js';
import { createMockClient } from '../../src/ai/mockClient.js';
import { createContactMessageStore } from '../../src/db/repos/contactMessages.js';

export const START = {
  name: 'Priya Nair',
  channel: 'email',
  email: 'priya@example.test',
  description: 'Veg lunch for 40 people on 13 Dec in Koramangala',
};

/** Fresh app, repos (seeded) and scripted mock AI. A fresh app also resets rate-limit counters. */
export function setup({ steps, env = {} } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', ...env });
  const repos = createRepos();
  seed(repos);
  const ai = createMockClient({ steps });
  const app = createApp(config, { contacts: createContactMessageStore(), repos, mailer: null, ai });
  return { app, repos, ai, config };
}

export const newest = (repos) => repos.enquiries.list()[0];
