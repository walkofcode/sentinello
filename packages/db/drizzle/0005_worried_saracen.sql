DROP INDEX `findings_identity_idx`;--> statement-breakpoint
CREATE INDEX `findings_identity_idx` ON `findings` (`project_id`,`source`,`ecosystem`,`advisory_id`,`package_name`);