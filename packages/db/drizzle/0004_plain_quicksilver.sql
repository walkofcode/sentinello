DROP INDEX `findings_identity_idx`;--> statement-breakpoint
ALTER TABLE `findings` ADD `source` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `ecosystem` text DEFAULT 'npm' NOT NULL;--> statement-breakpoint
CREATE INDEX `findings_identity_idx` ON `findings` (`project_id`,`scanner`,`ecosystem`,`advisory_id`,`package_name`);--> statement-breakpoint
DROP INDEX `mutes_identity_idx`;--> statement-breakpoint
ALTER TABLE `mutes` ADD `ecosystem` text;--> statement-breakpoint
CREATE INDEX `mutes_identity_idx` ON `mutes` (`project_id`,`scanner`,`ecosystem`,`advisory_id`,`package_name`);--> statement-breakpoint
ALTER TABLE `mute_lifts` ADD `ecosystem` text;--> statement-breakpoint
ALTER TABLE `notification_events` ADD `ecosystem` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `ecosystems_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `scans` ADD `source` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `ecosystem` text DEFAULT 'npm' NOT NULL;