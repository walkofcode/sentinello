CREATE TABLE `digest_deliveries` (
	`target_id` text NOT NULL,
	`week_key` text NOT NULL,
	`due_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`first_attempted_at` integer,
	`last_attempted_at` integer,
	`first_succeeded_at` integer,
	`dry_run_at` integer,
	`gave_up_at` integer,
	`suppressed_at` integer,
	`suppressed_reason` text,
	`last_error_text` text,
	PRIMARY KEY(`target_id`, `week_key`),
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_summary_resolved_told` (
	`target_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`told_at` integer NOT NULL,
	PRIMARY KEY(`target_id`, `finding_id`),
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_summary_unscannable_told` (
	`target_id` text NOT NULL,
	`project_id` text NOT NULL,
	`told_at` integer NOT NULL,
	PRIMARY KEY(`target_id`, `project_id`),
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `capability_baselines` ADD `cells_json` text;--> statement-breakpoint
ALTER TABLE `capability_baselines` ADD `scope_changed_at` integer;--> statement-breakpoint
ALTER TABLE `notification_targets` ADD `delivery` text DEFAULT 'per_project' NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_targets` ADD `weekly_digest` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_targets` ADD `run_summary_since_at` integer;--> statement-breakpoint
ALTER TABLE `notification_targets` ADD `digest_eligible_since_at` integer;--> statement-breakpoint
ALTER TABLE `scan_requests` ADD `origin` text DEFAULT 'manual' NOT NULL;