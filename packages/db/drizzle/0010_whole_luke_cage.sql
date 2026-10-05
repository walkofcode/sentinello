CREATE TABLE `registry_packages` (
	`ecosystem` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`summary_json` text,
	`weekly_downloads` integer,
	`downloads_checked_at` integer,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`ecosystem`, `name`)
);
--> statement-breakpoint
ALTER TABLE `findings` ADD `fix_status` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `fix_check_json` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `remediation_json` text;