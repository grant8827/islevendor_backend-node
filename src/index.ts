import { env } from './env.js';
import { createServer } from './app.js';

const { httpServer } = createServer();

httpServer.listen(env.PORT, () => {
  console.log(`IsleVendor API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});
