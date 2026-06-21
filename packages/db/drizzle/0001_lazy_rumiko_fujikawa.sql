CREATE TYPE "public"."agent_request_status" AS ENUM('pending', 'in_flight', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "agent_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedup_key" text,
	"status" "agent_request_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"result" jsonb,
	"doc_entry" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "outbox" CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_integration" ADD COLUMN "enabled_entities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_request_tenant_dedup_uq" ON "agent_request" USING btree ("tenant_id","dedup_key");--> statement-breakpoint
CREATE INDEX "agent_request_claim_idx" ON "agent_request" USING btree ("tenant_id","status","lease_until");--> statement-breakpoint
DROP TYPE "public"."outbox_status";