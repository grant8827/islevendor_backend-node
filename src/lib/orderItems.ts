import type { OrderItem } from '@prisma/client';

/** How order items read in a one-line summary: "Blender", or "Blender + 2 more". */
export function summarizeItems(items: Pick<OrderItem, 'title'>[]): string {
  if (items.length === 0) return 'Item no longer available';
  return items.length === 1 ? items[0].title : `${items[0].title} + ${items.length - 1} more`;
}

/** The fields every order view shows for each item. */
export function toItemView(item: OrderItem) {
  return {
    id: item.id,
    // Same id space as /commerce/listings/:id and ratings.
    listingId: item.storeListingId ?? item.shopProductId,
    title: item.title,
    imageUrl: item.imageUrl,
    quantity: item.quantity,
  };
}

export const ITEMS_IN_ORDER = { orderBy: { createdAt: 'asc' } } as const;
