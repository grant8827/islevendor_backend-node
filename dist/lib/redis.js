import { Redis } from 'ioredis';
import { env } from '../env.js';
// Shared Redis connection. Used for:
//  - GEOADD driver_locations <lng> <lat> <driverId>  (hot-path proximity lookups)
//  - session/idempotency locks
export const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
});
redis.on('error', (err) => {
    console.error('[redis] connection error:', err.message);
});
export const DRIVER_GEO_KEY = 'driver_locations';
//# sourceMappingURL=redis.js.map