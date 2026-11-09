ALTER TABLE `findings` ADD `notice_kind` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `aliases_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `advisory_key` text;--> statement-breakpoint
ALTER TABLE `notification_events` ADD `grade_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_events` ADD `policy_severity` text;--> statement-breakpoint
ALTER TABLE `notification_events` ADD `grade_answers_json` text;