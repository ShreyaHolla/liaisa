import { loadConfig } from './config.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

for (const w of config.warnings) console.warn(`WARNING: ${w}`);

createApp(config).listen(config.port, () => {
  console.log(`Liaisa listening on port ${config.port} (${config.env})`);
});
