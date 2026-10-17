import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';

export const uploadsRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');
export const PRIVATE_KYC_DIR = path.resolve(__dirname, '../../../private-kyc');

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// KYC/verification documents (COCJ registration, TRN card, proof of address,
// government ID, insurance/fitness certs) — images plus PDF, since several
// of those are routinely scanned as PDF. Used by modules/onboarding.
const ALLOWED_KYC_MIME_TYPES = new Set([...ALLOWED_MIME_TYPES, 'application/pdf']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// Local-disk public product storage for development. Production still needs a
// dedicated public-media object store.
const publicStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${randomUUID()}${ext}`);
  },
});

const privateKycStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PRIVATE_KYC_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${randomUUID()}${ext}`);
  },
});

const IMAGE_TYPES_BY_EXTENSION: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * The file on this server behind a URL that /uploads/image returned, or
 * null if the URL isn't one of ours (another host, a path outside the
 * uploads folder). Only the last path segment is used, so a crafted URL
 * can't reach anything outside UPLOADS_DIR.
 */
export function localUpload(url: string): { path: string; mimeType: string } | null {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://local').pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith('/uploads/')) return null;
  const name = path.basename(pathname);
  const mimeType = IMAGE_TYPES_BY_EXTENSION[path.extname(name).toLowerCase()];
  if (!mimeType || !/^[\w-]+\.\w+$/.test(name)) return null;
  return { path: path.join(UPLOADS_DIR, name), mimeType };
}

const upload = multer({
  storage: publicStorage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new HttpError(400, 'Only JPEG, PNG, WebP, or GIF images are allowed'));
      return;
    }
    cb(null, true);
  },
});

// Private local storage accepts PDF and images for onboarding. It is never
// mounted by express.static; production still needs encrypted private object
// storage plus short-lived, authorized retrieval.
export const kycUpload = multer({
  storage: privateKycStorage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_KYC_MIME_TYPES.has(file.mimetype)) {
      cb(new HttpError(400, 'Only JPEG, PNG, WebP, GIF, or PDF files are allowed'));
      return;
    }
    cb(null, true);
  },
});

// Generic image upload — any authenticated user can use it (a warehouse
// product photo today, driver KYC/proof-of-delivery photos later). What the
// resulting URL may be used for is still gated by each resource's own
// authorization (e.g. only the warehouse's owner can attach it to a product).
uploadsRouter.post('/image', requireAuth, upload.single('image'), (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'No image file provided');
    // Absolute, not relative: frontend and backend-node are separate hosts in
    // production (no reverse proxy between them, unlike vite.config.js's dev
    // proxy), so a bare "/uploads/…" would resolve against the frontend's own
    // domain wherever it's later rendered — build it from this request instead.
    res.status(201).json({ url: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}` });
  } catch (err) {
    next(err);
  }
});
