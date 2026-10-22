CREATE TABLE `fleet_managed_endpoints` (
	`node_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`proxy_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pending_cleanup` integer DEFAULT 0 NOT NULL,
	`owned_exclusive` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`node_id`, `endpoint_id`, `proxy_key`),
	FOREIGN KEY (`proxy_key`) REFERENCES `proxies`(`proxy_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fleet_managed_proxy_key` ON `fleet_managed_endpoints` (`proxy_key`);--> statement-breakpoint
CREATE INDEX `idx_fleet_managed_node_id` ON `fleet_managed_endpoints` (`node_id`);--> statement-breakpoint
CREATE TABLE `proxies` (
	`proxy_key` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`protocol` text NOT NULL,
	`host` text,
	`port` integer,
	`status` text DEFAULT 'dead' NOT NULL,
	`latency_ms` integer,
	`exit_ip` text,
	`successes` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`checked_at` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'legacy' NOT NULL,
	`lifecycle_state` text DEFAULT 'unknown' NOT NULL,
	`username` text,
	`password` text,
	`created_at` integer,
	`updated_at` integer,
	`last_verdict` text,
	`last_checked_at` integer,
	`last_latency_ms` integer,
	`last_exit_ip` text,
	`last_failure_code` text,
	`ever_passed` integer DEFAULT 0 NOT NULL,
	`is_pinned` integer DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`remote_id` text,
	`router_state` text DEFAULT 'unmanaged' NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE INDEX `proxies_lifecycle_idx` ON `proxies` (`lifecycle_state`);--> statement-breakpoint
CREATE INDEX `proxies_source_idx` ON `proxies` (`source`);--> statement-breakpoint
CREATE INDEX `proxies_protocol_lifecycle_idx` ON `proxies` (`protocol`,`lifecycle_state`);--> statement-breakpoint
CREATE INDEX `proxies_source_lifecycle_idx` ON `proxies` (`source`,`lifecycle_state`);--> statement-breakpoint
CREATE INDEX `proxies_last_checked_idx` ON `proxies` ("last_checked_at" desc);--> statement-breakpoint
CREATE TABLE `proxy_test_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proxy_key` text NOT NULL,
	`tested_at` integer NOT NULL,
	`ok` integer NOT NULL,
	`latency_ms` integer,
	`error_message` text,
	FOREIGN KEY (`proxy_key`) REFERENCES `proxies`(`proxy_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_proxy_test_history_key` ON `proxy_test_history` (`proxy_key`,"tested_at" desc);