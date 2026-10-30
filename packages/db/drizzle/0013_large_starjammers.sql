CREATE TABLE `capability_baselines` (
	`capability_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`swept_at` integer,
	`done_at` integer
);
--> statement-breakpoint
CREATE TABLE `capability_summary_deliveries` (
	`capability_id` text NOT NULL,
	`target_id` text NOT NULL,
	`counts_json` text NOT NULL,
	`policy_fingerprint` text NOT NULL,
	`first_attempted_at` integer,
	`last_attempted_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`first_succeeded_at` integer,
	`dry_run_at` integer,
	`gave_up_at` integer,
	`suppressed_at` integer,
	`suppressed_reason` text,
	`last_error_text` text,
	PRIMARY KEY(`capability_id`, `target_id`),
	FOREIGN KEY (`capability_id`) REFERENCES `capability_baselines`(`capability_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`scanner` text NOT NULL,
	`source` text,
	`ecosystem` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text,
	`duration_ms` integer NOT NULL,
	`error_text` text,
	`raw_json` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_scans`("id", "project_id", "started_at", "finished_at", "scanner", "source", "ecosystem", "status", "reason_code", "duration_ms", "error_text", "raw_json") SELECT "id", "project_id", "started_at", "finished_at", "scanner", "source", "ecosystem", "status", "reason_code", "duration_ms", "error_text", "raw_json" FROM `scans`;--> statement-breakpoint
DROP TABLE `scans`;--> statement-breakpoint
ALTER TABLE `__new_scans` RENAME TO `scans`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `scans_project_id_idx` ON `scans` (`project_id`);--> statement-breakpoint
CREATE INDEX `scans_finished_at_idx` ON `scans` (`finished_at`);--> statement-breakpoint
CREATE INDEX `scans_project_finished_idx` ON `scans` (`project_id`,`finished_at`);--> statement-breakpoint
CREATE TABLE `__new_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`project_id` text NOT NULL,
	`scanner` text NOT NULL,
	`source` text,
	`ecosystem` text NOT NULL,
	`advisory_id` text NOT NULL,
	`advisory_title` text,
	`advisory_url` text,
	`package_name` text NOT NULL,
	`installed_version` text NOT NULL,
	`vulnerable_range` text NOT NULL,
	`severity` text NOT NULL,
	`corroborations_json` text DEFAULT '[]' NOT NULL,
	`fix_available` integer DEFAULT false NOT NULL,
	`fix_version` text,
	`fix_status` text,
	`fix_check_json` text,
	`remediation_json` text,
	`dep_path_json` text DEFAULT '[]' NOT NULL,
	`is_prod` integer DEFAULT true NOT NULL,
	`is_dev` integer DEFAULT false NOT NULL,
	`first_detected_at` integer,
	`last_seen_at` integer,
	`resolved_at` integer,
	`resolved_scan_id` text,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_findings`("id", "scan_id", "project_id", "scanner", "source", "ecosystem", "advisory_id", "advisory_title", "advisory_url", "package_name", "installed_version", "vulnerable_range", "severity", "corroborations_json", "fix_available", "fix_version", "fix_status", "fix_check_json", "remediation_json", "dep_path_json", "is_prod", "is_dev", "first_detected_at", "last_seen_at", "resolved_at", "resolved_scan_id") SELECT "id", "scan_id", "project_id", "scanner", "source", "ecosystem", "advisory_id", "advisory_title", "advisory_url", "package_name", "installed_version", "vulnerable_range", "severity", "corroborations_json", "fix_available", "fix_version", "fix_status", "fix_check_json", "remediation_json", "dep_path_json", "is_prod", "is_dev", "first_detected_at", "last_seen_at", "resolved_at", "resolved_scan_id" FROM `findings`;--> statement-breakpoint
DROP TABLE `findings`;--> statement-breakpoint
ALTER TABLE `__new_findings` RENAME TO `findings`;--> statement-breakpoint
CREATE INDEX `findings_scan_id_idx` ON `findings` (`scan_id`);--> statement-breakpoint
CREATE INDEX `findings_project_id_idx` ON `findings` (`project_id`);--> statement-breakpoint
CREATE INDEX `findings_package_name_idx` ON `findings` (`package_name`);--> statement-breakpoint
CREATE INDEX `findings_identity_idx` ON `findings` (`project_id`,`source`,`ecosystem`,`advisory_id`,`package_name`);--> statement-breakpoint
CREATE INDEX `findings_resolved_at_idx` ON `findings` (`resolved_at`);--> statement-breakpoint
ALTER TABLE `notification_events` ADD `baseline_of` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `manifests_json` text DEFAULT '[]' NOT NULL;