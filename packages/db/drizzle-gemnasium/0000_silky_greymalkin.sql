CREATE TABLE `gemnasium_advisories` (
	`row_key` text PRIMARY KEY NOT NULL,
	`advisory_id` text NOT NULL,
	`ecosystem` text NOT NULL,
	`package_name` text NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`ranges_json` text DEFAULT '[]' NOT NULL,
	`versions_json` text DEFAULT '[]' NOT NULL,
	`severity` text,
	`summary` text,
	`url` text,
	`malicious` integer DEFAULT false NOT NULL,
	`withdrawn` integer
);
--> statement-breakpoint
CREATE INDEX `gemnasium_advisories_lookup_idx` ON `gemnasium_advisories` (`ecosystem`,`package_name`);--> statement-breakpoint
CREATE INDEX `gemnasium_advisories_advisory_id_idx` ON `gemnasium_advisories` (`advisory_id`);--> statement-breakpoint
CREATE TABLE `gemnasium_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
