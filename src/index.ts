import { env } from './env.js';
import { createServer } from './app.js';
import { refreshPaySettings, startPaySettingsRefresh } from './lib/platformSettings.js';

const { httpServer } = createServer();

// Pay settings (commission, payment switches) are read from a cache on hot
// paths; fill it before taking traffic and keep it fresh.
await refreshPaySettings();
startPaySettingsRefresh();

httpServer.listen(env.PORT, () => {
  console.log(`IsleVendor API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});
