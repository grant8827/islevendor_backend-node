import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../lib/audit.js';
import { findPublicListings } from '../commerce/commerce.routes.js';

// The home page's hero cards. An admin picks items already listed on the site
// (Admin Console → Home Hero) and a site colour for each; the card shows the
// item's own image and name and opens its product page.

// Site colours a card's background can use — the brand palette in the
// frontend's index.css. Keys, not hex, so a card can't go off-brand.
export const HERO_BACKGROUNDS = ['navy', 'primary', 'primary-dark', 'secondary', 'secondary-dark', 'white'] as const;

const idSchema = z.string().uuid();
const createSchema = z.object({
  listingId: z.string().uuid('Pick an item'),
  background: z.enum(HERO_BACKGROUNDS).default('navy'),
  isActive: z.boolean().default(true),
});
const updateSchema = z.object({
  background: z.enum(HERO_BACKGROUNDS).optional(),
  isActive: z.boolean().optional(),
});

const ordered = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];

/** The bit of a listing a hero card shows — plus its sale, for the sale tag. */
function cardItem(listing: { id: string; discountPercent: number; masterProduct: { title: string; imageUrl: string | null } }) {
  return { id: listing.id, title: listing.masterProduct.title, imageUrl: listing.masterProduct.imageUrl, discountPercent: listing.discountPercent };
}

/** Each slide with its item, or `item: null` when that item isn't for sale any more. */
async function withItems<T extends { listingId: string }>(slides: T[]) {
  const listings = await findPublicListings({ ids: slides.map((s) => s.listingId) });
  const byId = new Map(listings.map((l) => [l.id, cardItem(l)]));
  return slides.map((s) => ({ ...s, item: byId.get(s.listingId) ?? null }));
}

/** Public: GET /api/hero-slides — the active cards whose item is still for sale, in order. */
export const heroSlidesRouter = Router();

heroSlidesRouter.get('/', async (_req, res, next) => {
  try {
    const slides = await prisma.heroSlide.findMany({ where: { isActive: true }, orderBy: ordered, select: { id: true, listingId: true, background: true } });
    res.json(
      (await withItems(slides))
        .filter((s) => s.item)
        .map(({ id, background, item }) => ({ id, background, item })),
    );
  } catch (err) {
    next(err);
  }
});

/** Admin: /api/admin/hero-slides — mounted on the admin router, which already requires a current admin. */
export function registerHeroSlideRoutes(router: Router) {
  router.get('/hero-slides', async (_req, res, next) => {
    try {
      res.json(await withItems(await prisma.heroSlide.findMany({ orderBy: ordered })));
    } catch (err) {
      next(err);
    }
  });

  router.post('/hero-slides', async (req, res, next) => {
    try {
      const input = createSchema.parse(req.body);
      const [listing] = await findPublicListings({ ids: [input.listingId] });
      if (!listing) throw new HttpError(400, 'That item isn’t listed on the site');
      const slide = await prisma.$transaction(async (tx) => {
        if (await tx.heroSlide.findUnique({ where: { listingId: input.listingId }, select: { id: true } })) {
          throw new HttpError(409, 'That item is already in the hero');
        }
        const last = await tx.heroSlide.aggregate({ _max: { sortOrder: true } });
        const created = await tx.heroSlide.create({ data: { ...input, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
        await recordAuditEvent(req, { action: 'hero_slide.created', targetType: 'hero_slide', targetId: created.id, metadata: { listingId: listing.id, title: listing.masterProduct.title } }, tx);
        return created;
      });
      res.status(201).json({ ...slide, item: cardItem(listing) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/hero-slides/:id', async (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      const input = updateSchema.parse(req.body);
      const slide = await prisma.$transaction(async (tx) => {
        if (!(await tx.heroSlide.findUnique({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'Hero card not found');
        const updated = await tx.heroSlide.update({ where: { id }, data: input });
        await recordAuditEvent(req, { action: 'hero_slide.updated', targetType: 'hero_slide', targetId: id, metadata: { ...input } }, tx);
        return updated;
      });
      res.json(slide);
    } catch (err) {
      next(err);
    }
  });

  // Reorder: every card's id, in the order they should show.
  router.put('/hero-slides/order', async (req, res, next) => {
    try {
      const ids = z.array(idSchema).max(200).parse(req.body?.ids);
      await prisma.$transaction(async (tx) => {
        const known = new Set((await tx.heroSlide.findMany({ select: { id: true } })).map((s) => s.id));
        if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((i) => known.has(i))) {
          throw new HttpError(400, 'Send every hero card exactly once');
        }
        await Promise.all(ids.map((id, sortOrder) => tx.heroSlide.update({ where: { id }, data: { sortOrder } })));
        await recordAuditEvent(req, { action: 'hero_slide.reordered', targetType: 'hero_slide', targetId: 'all', metadata: { ids } }, tx);
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/hero-slides/:id', async (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      await prisma.$transaction(async (tx) => {
        const slide = await tx.heroSlide.findUnique({ where: { id }, select: { listingId: true } });
        if (!slide) throw new HttpError(404, 'Hero card not found');
        await tx.heroSlide.delete({ where: { id } });
        await recordAuditEvent(req, { action: 'hero_slide.deleted', targetType: 'hero_slide', targetId: id, metadata: { listingId: slide.listingId } }, tx);
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
