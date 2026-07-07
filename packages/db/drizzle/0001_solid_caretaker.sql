CREATE TABLE "portal_client" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"card_code" text NOT NULL,
	"card_name" text NOT NULL,
	"user_id" text,
	"invite_token_hash" text NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "config_model" ADD COLUMN "portal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "config_model" ADD COLUMN "portal_description" text;--> statement-breakpoint
ALTER TABLE "config_project" ADD COLUMN "source" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "config_project" ADD COLUMN "rejection_note" text;--> statement-breakpoint
ALTER TABLE "config_project" ADD COLUMN "events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_client_token_uq" ON "portal_client" USING btree ("invite_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_client_tenant_user_uq" ON "portal_client" USING btree ("tenant_id","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "portal_client_tenant_idx" ON "portal_client" USING btree ("tenant_id");