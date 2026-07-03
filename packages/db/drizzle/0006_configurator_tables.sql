CREATE TABLE "config_model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"model_id" uuid NOT NULL,
	"name" text NOT NULL,
	"customer" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"entries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"batches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"model_snapshot" jsonb NOT NULL,
	"lookup_snapshot" jsonb NOT NULL,
	"entries" jsonb NOT NULL,
	"candidates" jsonb NOT NULL,
	"selection" jsonb,
	"b1_doc_entry" integer,
	"quoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "config_model_tenant_idx" ON "config_model" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "config_project_tenant_status_idx" ON "config_project" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "config_run_tenant_project_idx" ON "config_run" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_table_tenant_name_uq" ON "config_table" USING btree ("tenant_id","name");