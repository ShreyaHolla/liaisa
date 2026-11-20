import { createContactMessageStore } from './db/repos/contactMessages.js';
import { createRegistry } from './db/registry.js';
import { createMockClient } from './ai/mockClient.js';
import { createClaudeClient } from './ai/claudeClient.js';
import { createSmtpMailer } from './mail/smtpTransport.js';

export { createRepos } from './db/repos/index.js';

/**
 * Wires adapters by env. mailer is null when MAIL_ENABLED=false. The registry starts with the demo business
 * (seeded) and its owner; `repos` is the demo business's repo set (handy for tests and boot logging).
 */
export function buildDeps(config) {
  const registry = createRegistry({ maxBusinesses: config.maxBusinesses });
  const repos = registry.addDemo(config);
  return {
    contacts: createContactMessageStore(),
    registry,
    repos,
    ai: config.aiMode === 'live'
      ? createClaudeClient({ apiKey: config.anthropicApiKey, models: { intake: config.ai.modelIntake, outreach: config.ai.modelOutreach, discovery: config.ai.modelDiscovery } })
      : createMockClient(),
    mailer: config.mailEnabled ? createSmtpMailer(config.smtp) : null,
  };
}
