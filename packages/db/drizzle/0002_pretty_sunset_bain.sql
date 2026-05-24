CREATE TABLE `worker_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`claimed_at` integer
);
--> statement-breakpoint
CREATE INDEX `worker_signals_claimed_at_idx` ON `worker_signals` (`claimed_at`);