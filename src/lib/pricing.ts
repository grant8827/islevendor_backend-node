import { Decimal } from 'decimal.js';

import { platformCommissionRate } from './platformSettings.js';

// IsleVendor's commission is a percentage of the seller's (post-discount)
// price on every item sold — AFFILIATE and STORE alike — set by an admin in
// IsleVendor Pay (5% unless changed; see lib/platformSettings.ts). Orders
// keep the amount they were charged, so a change affects new orders only.

/**
 * AFFILIATE pricing: the reseller's cut and the platform's cut are each a
 * percentage of the warehouse's own (post-discount) wholesale price, added
 * on top to form what the customer pays — the warehouse always receives
 * exactly its own listed (and possibly discounted) price in full. Because
 * every cut is computed off that same wholesale base, a warehouse discount
 * shrinks the reseller's and platform's take too, not just the warehouse's
 * own — this is used identically at listing-display time (commerce.routes.ts)
 * and at checkout time (orders.routes.ts) so the price a customer is shown
 * is always exactly the price they're charged.
 *
 * `resellerCommissionPercent` is set by the warehouse itself (see
 * Warehouse.resellerCommissionPercent) — not the reseller, and not a global
 * platform-wide rate like IsleVendor's own commission.
 */
export function computeAffiliatePricing({
  wholesalePriceJmd,
  discountPercent,
  resellerCommissionPercent,
  quantity = 1,
}: {
  wholesalePriceJmd: Decimal.Value;
  discountPercent: number;
  resellerCommissionPercent: number;
  quantity?: number;
}) {
  const discountMultiplier = new Decimal(1).minus(new Decimal(discountPercent).dividedBy(100));
  const unitWholesaleJmd = new Decimal(wholesalePriceJmd).times(discountMultiplier).toDecimalPlaces(2);
  const wholesaleTotalJmd = unitWholesaleJmd.times(quantity);
  const resellerMarginJmd = wholesaleTotalJmd.times(new Decimal(resellerCommissionPercent).dividedBy(100)).toDecimalPlaces(2);
  const platformCommissionJmd = wholesaleTotalJmd.times(platformCommissionRate()).toDecimalPlaces(2);
  const retailTotalJmd = wholesaleTotalJmd.plus(resellerMarginJmd).plus(platformCommissionJmd);

  return { unitWholesaleJmd, wholesaleTotalJmd, resellerMarginJmd, platformCommissionJmd, retailTotalJmd };
}
