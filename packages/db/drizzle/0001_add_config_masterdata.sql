CREATE TABLE "config_masterdata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text,
	"path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "config_masterdata_tenant_idx" ON "config_masterdata" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_masterdata_tenant_name_uq" ON "config_masterdata" USING btree ("tenant_id","name");