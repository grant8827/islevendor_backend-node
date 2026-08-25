import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }

  if (err instanceof MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB' : err.message;
    return res.status(400).json({ error: message });
  }

  // Every route's `<schema>.parse(req.body)` throws this on invalid input
  // (missing required field, bad email, out-of-range number, etc.) — until
  // now it fell through to the generic 500 below, which is what a client
  // actually saw for *any* validation failure on *any* form in the app, not
  // just the new onboarding ones. `error` is the first issue's message (what
  // every existing caller reads via err.message), `fieldErrors` gives a
  // per-field breakdown for a form to show inline next to each input.
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '(root)';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return res.status(400).json({ error: first?.message ?? 'Invalid request', fieldErrors });
  }

  console.error('[unhandled error]', err);
  return res.status(500).json({ error: 'Internal server error' });
}
