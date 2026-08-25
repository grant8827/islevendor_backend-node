import { z } from 'zod';

// Accepts a full external URL or our own upload endpoint's relative path
// (e.g. "/uploads/<file>.jpg") — z.string().url() alone rejects the latter
// since it isn't an absolute URL. Shared by warehouse and shop product routes.
export const imageUrlSchema = z
  .string()
  .refine((val) => val.startsWith('/uploads/') || /^https?:\/\//.test(val), {
    message: 'Must be a valid image URL or an uploaded file path',
  });
