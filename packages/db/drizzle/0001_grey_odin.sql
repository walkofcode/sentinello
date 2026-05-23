PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`target_id` text,
	`first_attempted_at` integer,
	`first_succeeded_at` integer,
	`last_attempted_at` integer,
	`last_error_text` text,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_notification_deliveries`("id", "event_id", "target_id", "first_attempted_at", "first_succeeded_at", "last_attempted_at", "last_error_text") SELECT "id", "event_id", "target_id", "first_attempted_at", "first_succeeded_at", "last_attempted_at", "last_error_text" FROM `notification_deliveries`;--> statement-breakpoint
DROP TABLE `notification_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_notification_deliveries` RENAME TO `notification_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_pair_uidx` ON `notification_deliveries` (`event_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_event_id_idx` ON `notification_deliveries` (`event_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_target_id_idx` ON `notification_deliveries` (`target_id`);