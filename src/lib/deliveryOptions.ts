import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { DeliveryMethod, Prisma } from '@prisma/client';
import { HttpError } from '../middleware/errorHandler.js';

// How an order can reach the customer, and what each way costs. The
// business that packs the order (a shop, or the warehouse behind a reseller
// listing) decides which of these it offers; the customer picks one at
// checkout.
//  - ISLEDASH:        an IsleDash driver, at the platform's driver fee. The fee
//                     is held for the driver (see ledger.service.ts).
//  - SELLER_DELIVERY: the business's own delivery, at the fee it sets. The fee
//                     is the business's.
//  - PICKUP:          the customer collects it. Always free.

// MVP flat IsleDash fee — will move to per-warehouse / distance-based values
// once the FastAPI routing service is wired up.
export const ISLEDASH_FEE_JMD = new Decimal(300);

/** The columns deliveryOptionsFor needs — select these wherever a warehouse or shop is loaded for checkout. */
export const DELIVERY_SETTINGS_SELECT = {
  addressLine: true,
  parish: true,
  offersIsleDash: true,
  offersSellerDelivery: true,
  sellerDeliveryFeeJmd: true,
  sellerDeliveryNote: true,
  offersPickup: true,
  pickupInstructions: true,
} as const;

export interface DeliverySettings {
  addressLine: string;
  parish: string;
  /** A shop's separate pickup address, if it has one; otherwise its main address is where customers collect. */
  pickupAddress?: string | null;
  offersIsleDash: boolean;
  offersSellerDelivery: boolean;
  sellerDeliveryFeeJmd: Prisma.Decimal | null;
  sellerDeliveryNote: string | null;
  offersPickup: boolean;
  pickupInstructions: string | null;
}

export interface DeliveryOption {
  method: DeliveryMethod;
  label: string;
  feeJmd: string;
  /** What the customer should know about this option — where to collect, the business's delivery terms. */
  detail: string | null;
  /** Whether the customer has to give a delivery address. */
  needsAddress: boolean;
}

export function pickupLocationOf(seller: DeliverySettings): string {
  return `${seller.pickupAddress || seller.addressLine}, ${seller.parish}`;
}

/** Every option this business currently offers, in the order a customer should see them. */
export function deliveryOptionsFor(seller: DeliverySettings): DeliveryOption[] {
  const options: DeliveryOption[] = [];
  if (seller.offersIsleDash) {
    options.push({ method: 'ISLEDASH', label: 'IsleDash delivery', feeJmd: ISLEDASH_FEE_JMD.toFixed(2), detail: null, needsAddress: true });
  }
  if (seller.offersSellerDelivery && seller.sellerDeliveryFeeJmd !== null) {
    options.push({
      method: 'SELLER_DELIVERY',
      label: 'Delivered by the seller',
      feeJmd: new Decimal(seller.sellerDeliveryFeeJmd.toString()).toFixed(2),
      detail: seller.sellerDeliveryNote,
      needsAddress: true,
    });
  }
  if (seller.offersPickup) {
    const where = pickupLocationOf(seller);
    options.push({
      method: 'PICKUP',
      label: 'Pick up',
      feeJmd: '0.00',
      detail: seller.pickupInstructions ? `${where} — ${seller.pickupInstructions}` : where,
      needsAddress: false,
    });
  }
  return options;
}

/**
 * What `method` costs for an order from `seller`, split by who it's owed to.
 * Throws 400 if the business doesn't offer that method.
 */
export function deliveryFeesFor(seller: DeliverySettings, method: DeliveryMethod): { driverFeeJmd: Decimal; sellerDeliveryFeeJmd: Decimal } {
  const option = deliveryOptionsFor(seller).find((o) => o.method === method);
  if (!option) throw new HttpError(400, "This seller doesn't offer that delivery option — choose another");
  const fee = new Decimal(option.feeJmd);
  return {
    driverFeeJmd: method === 'ISLEDASH' ? fee : new Decimal(0),
    sellerDeliveryFeeJmd: method === 'SELLER_DELIVERY' ? fee : new Decimal(0),
  };
}

/** What a business submits to change its delivery options. */
export const deliverySettingsSchema = z
  .object({
    offersIsleDash: z.boolean(),
    offersSellerDelivery: z.boolean(),
    sellerDeliveryFeeJmd: z.number().min(0).max(100_000).nullable().optional(),
    sellerDeliveryNote: z.string().trim().max(300).nullable().optional(),
    offersPickup: z.boolean(),
    pickupInstructions: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => v.offersIsleDash || v.offersSellerDelivery || v.offersPickup, {
    message: 'Offer at least one way for customers to get their order',
  })
  .refine((v) => !v.offersSellerDelivery || (v.sellerDeliveryFeeJmd !== null && v.sellerDeliveryFeeJmd !== undefined), {
    message: 'Set a fee for your own delivery (it can be 0)',
    path: ['sellerDeliveryFeeJmd'],
  })
  .transform((v) => ({
    offersIsleDash: v.offersIsleDash,
    offersSellerDelivery: v.offersSellerDelivery,
    sellerDeliveryFeeJmd: v.offersSellerDelivery ? v.sellerDeliveryFeeJmd! : null,
    sellerDeliveryNote: v.sellerDeliveryNote || null,
    offersPickup: v.offersPickup,
    pickupInstructions: v.pickupInstructions || null,
  }));
