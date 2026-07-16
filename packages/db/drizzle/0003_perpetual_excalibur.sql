CREATE TABLE "config_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"model_id" uuid NOT NULL,
	"row" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "config_history_tenant_model_idx" ON "config_history" USING btree ("tenant_id","model_id");