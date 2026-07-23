CREATE TABLE "assistant_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_user_id" text,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_tool_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"replay_tool_call_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"operation_key" text NOT NULL,
	"event_seq" integer,
	"name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"lease_token" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"result" jsonb,
	"error_code" text,
	"observed_project_version" timestamp with time zone,
	"affected_project_version" timestamp with time zone,
	"run_id" uuid,
	"duration_ms" integer,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assistant_turn" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"initial_project_version" timestamp with time zone NOT NULL,
	"latest_project_version" timestamp with time zone NOT NULL,
	"initial_entries" jsonb NOT NULL,
	"initial_batches" jsonb NOT NULL,
	"working_entries" jsonb NOT NULL,
	"working_batches" jsonb NOT NULL,
	"working_revision" integer DEFAULT 0 NOT NULL,
	"next_seq" integer DEFAULT 0 NOT NULL,
	"iteration_count" integer DEFAULT 0 NOT NULL,
	"emitted_tool_call_count" integer DEFAULT 0 NOT NULL,
	"executed_tool_call_count" integer DEFAULT 0 NOT NULL,
	"provider_call_count" integer DEFAULT 0 NOT NULL,
	"wrap_up_attempted" boolean DEFAULT false NOT NULL,
	"calculated_run_id" uuid,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"user_message" text NOT NULL,
	"attachment_name" text,
	"attachment_mime" text,
	"attachment_sha256" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assistant_message" ADD CONSTRAINT "assistant_message_conversation_id_assistant_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_tool_execution" ADD CONSTRAINT "assistant_tool_execution_turn_id_assistant_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."assistant_turn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turn" ADD CONSTRAINT "assistant_turn_conversation_id_assistant_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_conv_tenant_project_idx" ON "assistant_conversation" USING btree ("tenant_id","project_id","updated_at");--> statement-breakpoint
CREATE INDEX "assistant_msg_conv_idx" ON "assistant_message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_msg_turn_role_uq" ON "assistant_message" USING btree ("turn_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_tool_exec_op_uq" ON "assistant_tool_execution" USING btree ("turn_id","operation_key");--> statement-breakpoint
CREATE INDEX "assistant_turn_conv_idx" ON "assistant_turn" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turn_running_conv_uq" ON "assistant_turn" USING btree ("conversation_id") WHERE "assistant_turn"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turn_running_user_uq" ON "assistant_turn" USING btree ("user_id") WHERE "assistant_turn"."status" = 'running';