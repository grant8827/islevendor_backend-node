-- Session revocation: every login token carries the version it was issued
-- under, and is only accepted while that still matches (see
-- middleware/auth.ts). Bumping the number signs the user out everywhere.
-- Tokens issued before this column existed carry no version and are treated
-- as version 0, so nobody is signed out by this migration itself.
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
