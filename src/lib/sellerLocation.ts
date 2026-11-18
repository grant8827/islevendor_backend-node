import { prisma } from './prisma.js';
import type { MapPin } from './isleDashPricing.js';

/**
 * Places a shop's or warehouse's exact map pin. Sets the pin columns that
 * IsleDash prices distance from (lib/isleDashPricing.ts) and the PostGIS
 * `location` that driver dispatch searches around — until now only a
 * parish centre. Both in one statement, so they can't disagree.
 */
export async function setSellerPin(kind: 'shop' | 'warehouse', id: string, pin: MapPin) {
  const lat = Math.round(pin.latitude * 1e6) / 1e6;
  const lng = Math.round(pin.longitude * 1e6) / 1e6;
  if (kind === 'shop') {
    await prisma.$executeRaw`
      UPDATE shops SET pin_latitude = ${lat}, pin_longitude = ${lng}, location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
      WHERE id = ${id}::uuid`;
  } else {
    await prisma.$executeRaw`
      UPDATE warehouses SET pin_latitude = ${lat}, pin_longitude = ${lng}, location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
      WHERE id = ${id}::uuid`;
  }
  return { latitude: lat, longitude: lng };
}
