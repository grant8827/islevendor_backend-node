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
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// KYC/verification documents (COCJ registration, TRN card, proof of address,
// government ID, insurance/fitness certs) — images plus PDF, since several
// of those are routinely scanned as PDF. Used by modules/onboarding.
const ALLOWED_KYC_MIME_TYPES = new Set([...ALLOWED_MIME_TYPES, 'application/pdf']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
// Local-disk storage for dev. Swap for S3/Cloudinary before production — this
// won't survive a redeploy on most hosts and doesn't scale past one instance.
// TODO(ISLE-105): swap for S3 + pre-signed short-lived URLs and encryption
// at rest before this handles real KYC documents in production — tracked
// separately since it needs real AWS credentials this environment doesn't have.
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `${randomUUID()}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
            cb(new HttpError(400, 'Only JPEG, PNG, WebP, or GIF images are allowed'));
            return;
        }
        cb(null, true);
    },
});
// Same disk storage, but also accepts PDF — used to receive onboarding KYC
// documents alongside each portal's form fields in one multipart submission.
export const kycUpload = multer({
    storage,
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
        if (!req.file)
            throw new HttpError(400, 'No image file provided');
        res.status(201).json({ url: `/uploads/${req.file.filename}` });
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=uploads.routes.js.map