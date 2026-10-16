import { z } from 'zod';
import type { CustomerAddress } from '@prisma/client';
import { PARISHES, type Parish } from './parishes.js';

// Jamaica, with a margin for GPS error near the coast. A pin outside this
// is a phone reporting somewhere else (or a typo) and isn't saved.
const JAMAICA = { minLat: 17.5, maxLat: 18.7, minLng: -78.6, maxLng: -76.0 };

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());

/** A map pin, rounded to ~10 cm. Both coordinates or neither. */
export const mapPinSchema = z.object({
  latitude: z.number().min(JAMAICA.minLat, 'That location is outside Jamaica').max(JAMAICA.maxLat, 'That location is outside Jamaica'),
  longitude: z.number().min(JAMAICA.minLng, 'That location is outside Jamaica').max(JAMAICA.maxLng, 'That location is outside Jamaica'),
});

/** What a customer enters for delivery: at sign-up, on My Account, or both. */
export const addressSchema = z.object({
  addressLine1: z.string().trim().min(3, 'Enter your street address').max(120),
  addressLine2: optionalText(120),
  town: z.string().trim().min(2, 'Enter your town or district').max(80),
  parish: z.enum(PARISHES as unknown as [Parish, ...Parish[]], { message: 'Choose your parish' }),
  // Jamaican addresses often need one: "opposite the Texaco", "green gate".
  landmark: optionalText(200),
  deliveryInstructions: optionalText(300),
  location: mapPinSchema.nullish(),
});
export type AddressInput = z.infer<typeof addressSchema>;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Database fields for an address (create or update). */
export function addressData(input: AddressInput) {
  return {
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 ?? null,
    town: input.town,
    parish: input.parish,
    landmark: input.landmark ?? null,
    deliveryInstructions: input.deliveryInstructions ?? null,
    latitude: input.location ? round6(input.location.latitude) : null,
    longitude: input.location ? round6(input.location.longitude) : null,
  };
}

/** The address as the customer's apps see it. */
export function toAddressView(a: CustomerAddress) {
  return {
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2,
    town: a.town,
    parish: a.parish,
    landmark: a.landmark,
    deliveryInstructions: a.deliveryInstructions,
    location: a.latitude !== null && a.longitude !== null ? { latitude: Number(a.latitude), longitude: Number(a.longitude) } : null,
    formatted: formatAddress(a),
    updatedAt: a.updatedAt,
  };
}

type AddressText = {
  addressLine1: string;
  addressLine2?: string | null;
  town: string;
  parish: string;
  landmark?: string | null;
  deliveryInstructions?: string | null;
};

/**
 * One line for labels, the driver and the seller: what goes in an order's
 * deliveryAddress. e.g. "12 Hope Road, Apt 4, Liguanea, St. Andrew —
 * Landmark: opposite the Texaco — Note: call on arrival".
 */
export function formatAddress(a: AddressText) {
  const place = [a.addressLine1, a.addressLine2, a.town, a.parish].filter(Boolean).join(', ');
  return [place, a.landmark && `Landmark: ${a.landmark}`, a.deliveryInstructions && `Note: ${a.deliveryInstructions}`]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 500);
}
