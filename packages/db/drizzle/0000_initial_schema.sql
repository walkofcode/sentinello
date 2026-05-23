CREATE TABLE `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`project_id` text NOT NULL,
	`scanner` text NOT NULL,
	`advisory_id` text NOT NULL,
	`advisory_title` text,
	`advisory_url` text,
	`package_name` text NOT NULL,
	`installed_version` text NOT NULL,
	`vulnerable_range` text NOT NULL,
	`severity` text NOT NULL,
	`fix_available` integer DEFAULT false NOT NULL,
	`fix_version` text,
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
CREATE INDEX `findings_scan_id_idx` ON `findings` (`scan_id`);--> statement-breakpoint
CREATE INDEX `findings_project_id_idx` ON `findings` (`project_id`);--> statement-breakpoint
CREATE INDEX `findings_package_name_idx` ON `findings` (`package_name`);--> statement-breakpoint
CREATE INDEX `findings_identity_idx` ON `findings` (`project_id`,`scanner`,`advisory_id`,`package_name`);--> statement-breakpoint
CREATE INDEX `findings_resolved_at_idx` ON `findings` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `mute_lifts` (
	`id` text PRIMARY KEY NOT NULL,
	`mute_id` text NOT NULL,
	`lifted_at` integer NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`scanner` text,
	`advisory_id` text,
	`package_name` text,
	`reason` text NOT NULL,
	`author` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mute_lifts_project_id_idx` ON `mute_lifts` (`project_id`);--> statement-breakpoint
CREATE INDEX `mute_lifts_lifted_at_idx` ON `mute_lifts` (`lifted_at`);--> statement-breakpoint
CREATE TABLE `mutes` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`scanner` text,
	`advisory_id` text,
	`package_name` text,
	`reason` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mutes_scope_idx` ON `mutes` (`scope`);--> statement-breakpoint
CREATE INDEX `mutes_project_id_idx` ON `mutes` (`project_id`);--> statement-breakpoint
CREATE INDEX `mutes_identity_idx` ON `mutes` (`project_id`,`scanner`,`advisory_id`,`package_name`);--> statement-breakpoint
CREATE INDEX `mutes_expires_at_idx` ON `mutes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`target_id` text NOT NULL,
	`first_attempted_at` integer,
	`first_succeeded_at` integer,
	`last_attempted_at` integer,
	`last_error_text` text,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_pair_uidx` ON `notification_deliveries` (`event_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_event_id_idx` ON `notification_deliveries` (`event_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_target_id_idx` ON `notification_deliveries` (`target_id`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`identity_key` text NOT NULL,
	`project_id` text NOT NULL,
	`scanner` text NOT NULL,
	`advisory_id` text,
	`package_name` text,
	`severity` text,
	`failure_signature` text,
	`first_scan_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`first_notified_at` integer,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`first_scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_identity_key_uidx` ON `notification_events` (`identity_key`);--> statement-breakpoint
CREATE INDEX `notification_events_project_event_type_idx` ON `notification_events` (`project_id`,`event_type`);--> statement-breakpoint
CREATE TABLE `notification_target_projects` (
	`target_id` text NOT NULL,
	`project_id` text NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_target_projects_pair_uidx` ON `notification_target_projects` (`target_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `notification_target_projects_target_id_idx` ON `notification_target_projects` (`target_id`);--> statement-breakpoint
CREATE INDEX `notification_target_projects_project_id_idx` ON `notification_target_projects` (`project_id`);--> statement-breakpoint
CREATE TABLE `notification_target_roots` (
	`target_id` text NOT NULL,
	`root_id` text NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_id`) REFERENCES `roots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_target_roots_pair_uidx` ON `notification_target_roots` (`target_id`,`root_id`);--> statement-breakpoint
CREATE INDEX `notification_target_roots_target_id_idx` ON `notification_target_roots` (`target_id`);--> statement-breakpoint
CREATE INDEX `notification_target_roots_root_id_idx` ON `notification_target_roots` (`root_id`);--> statement-breakpoint
CREATE TABLE `notification_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`config_json` text NOT NULL,
	`severity_filter_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_targets_enabled_idx` ON `notification_targets` (`enabled`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`root_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`name` text NOT NULL,
	`alias` text,
	`package_manager` text NOT NULL,
	`nvmrc_version` text,
	`muted` integer DEFAULT false NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`root_id`) REFERENCES `roots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `projects_root_id_idx` ON `projects` (`root_id`);--> statement-breakpoint
CREATE TABLE `roots` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roots_path_unique` ON `roots` (`path`);--> statement-breakpoint
CREATE TABLE `scan_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`root_id` text,
	`requested_at` integer NOT NULL,
	`picked_up_at` integer,
	`finished_at` integer,
	`heartbeat_at` integer,
	`status` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_id`) REFERENCES `roots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scan_requests_status_requested_at_idx` ON `scan_requests` (`status`,`requested_at`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`scanner` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text,
	`duration_ms` integer NOT NULL,
	`error_text` text,
	`raw_json` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scans_project_id_idx` ON `scans` (`project_id`);--> statement-breakpoint
CREATE INDEX `scans_finished_at_idx` ON `scans` (`finished_at`);