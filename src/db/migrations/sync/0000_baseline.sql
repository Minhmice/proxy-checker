CREATE TABLE `baselines` (
	`resource` text NOT NULL,
	`key` text NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`resource`, `key`, `field`)
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`router_id` text NOT NULL,
	`resource` text NOT NULL,
	`key` text NOT NULL,
	`field` text,
	`kind` text NOT NULL,
	`expected` text,
	`expected_revision` text,
	`desired` text,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_operations_status` ON `operations` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`resource` text NOT NULL,
	`key` text NOT NULL,
	`field` text,
	`revision` integer NOT NULL,
	`reason` text NOT NULL,
	`base` text,
	`a` text,
	`b` text,
	`resolved` integer DEFAULT 0 NOT NULL,
	`resolved_value` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_conflicts_resource_key` ON `conflicts` (`resource`,`key`);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text NOT NULL,
	`namespace` text NOT NULL,
	`source_router_id` text NOT NULL,
	`account_key` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`metric` text NOT NULL,
	`unit` text NOT NULL,
	`currency` text,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`amount` text NOT NULL,
	`accuracy` text NOT NULL,
	`provenance` text NOT NULL,
	`generation` text NOT NULL,
	`cursor` text NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`source_router_id`, `namespace`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_usage_events_scope` ON `usage_events` (`account_key`,`provider`,`model`,`metric`,`unit`,`period_start`,`period_end`);
--> statement-breakpoint
CREATE TABLE `usage_writes` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`router_id` text NOT NULL,
	`account_key` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`metric` text NOT NULL,
	`unit` text NOT NULL,
	`currency` text,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`ledger_revision` integer NOT NULL,
	`strategy` text NOT NULL,
	`amount` text NOT NULL,
	`expected_boundary` text NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_writes_status` ON `usage_writes` (`status`);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`boundary` text,
	`evidence` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leases` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`epoch` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`report_json` text NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_run_reports_verified` ON `run_reports` (`status`,"verified_at" desc);
--> statement-breakpoint
CREATE TABLE `sync_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`usage_write_back_authorized` integer DEFAULT 0 NOT NULL,
	`next_incremental_at` integer DEFAULT 0 NOT NULL,
	`next_full_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);

CREATE TABLE proxy_ownership (
 endpoint_key TEXT PRIMARY KEY,router_id TEXT NOT NULL,account_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,epoch INTEGER NOT NULL,binding_revision INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,state TEXT NOT NULL);
CREATE TABLE proxy_ownership_operations (
 operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT NOT NULL);
CREATE TABLE proxy_bindings (
 router_id TEXT NOT NULL,account_id TEXT NOT NULL,endpoint_key TEXT NOT NULL,
 PRIMARY KEY(router_id,account_id));
