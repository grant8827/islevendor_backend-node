-- A business's conversation with a driver who applied to deliver for it:
-- scheduling an in-person interview, asking for more information, the
-- decision, and free-text messages both ways (see delivery.routes.ts).

-- The interview currently scheduled, if any. A reschedule overwrites it; the
-- message history keeps every version.
ALTER TABLE "delivery_applications"
  ADD COLUMN "interview_at" TIMESTAMPTZ,
  ADD COLUMN "interview_location" TEXT,
  ADD COLUMN "info_requested_at" TIMESTAMPTZ;

CREATE TYPE "MessageSide" AS ENUM ('BUSINESS', 'DRIVER');
CREATE TYPE "ApplicationMessageKind" AS ENUM ('MESSAGE', 'INTERVIEW_SCHEDULED', 'INFO_REQUESTED', 'DECISION');

CREATE TABLE "application_messages" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "sender_user_id" UUID,
    "sender_side" "MessageSide" NOT NULL,
    "kind" "ApplicationMessageKind" NOT NULL DEFAULT 'MESSAGE',
    "body" TEXT NOT NULL,
    -- For INTERVIEW_SCHEDULED: when and where, as offered in this message.
    "interview_at" TIMESTAMPTZ,
    "interview_location" TEXT,
    -- When the other side first opened it.
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "application_messages_application_id_created_at_idx" ON "application_messages"("application_id", "created_at");
ALTER TABLE "application_messages" ADD CONSTRAINT "application_messages_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "delivery_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_messages" ADD CONSTRAINT "application_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
