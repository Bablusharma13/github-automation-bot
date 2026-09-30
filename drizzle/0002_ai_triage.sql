ALTER TABLE "rules" ADD COLUMN "ai_triage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "ai_status" "step_status";--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "ai_result" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "ai_model" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "ai_error" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "ai_completed_at" timestamp with time zone;