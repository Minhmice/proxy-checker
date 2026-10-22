CREATE TABLE `fleet_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`revision` integer NOT NULL,
	`config_digest` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`applied_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `fleet_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fleet_deployments_node` ON `fleet_deployments` (`node_id`,"revision" desc);--> statement-breakpoint
CREATE TABLE `fleet_egresses` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`interface_id` text,
	`name` text NOT NULL,
	`source_ip` text,
	`gateway_ip` text,
	`routing_table_id` integer,
	`expected_public_ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `fleet_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`interface_id`) REFERENCES `fleet_node_interfaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `fleet_enrollment_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`node_name` text NOT NULL,
	`assigned_ip` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fleet_events` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text,
	`endpoint_id` text,
	`event_type` text NOT NULL,
	`level` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fleet_events_created` ON `fleet_events` ("created_at" desc);--> statement-breakpoint
CREATE TABLE `fleet_health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`node_id` text NOT NULL,
	`status` text NOT NULL,
	`exit_ip` text,
	`latency_ms` real,
	`error_message` text,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `fleet_proxy_endpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `fleet_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fleet_health_endpoint` ON `fleet_health_checks` (`endpoint_id`,"checked_at" desc);--> statement-breakpoint
CREATE TABLE `fleet_node_interfaces` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`name` text NOT NULL,
	`mac_address` text,
	`ipv4_address` text,
	`ipv6_address` text,
	`is_default` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `fleet_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fleet_node_removals` (
	`node_id` text PRIMARY KEY NOT NULL,
	`node_name` text NOT NULL,
	`wireguard_ip` text NOT NULL,
	`wireguard_public_key` text,
	`status` text NOT NULL,
	`error_message` text,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fleet_removals_status` ON `fleet_node_removals` (`status`);--> statement-breakpoint
CREATE TABLE `fleet_node_ssh` (
	`node_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`encrypted_password` text NOT NULL,
	`salt` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`host_key_fingerprint` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `fleet_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fleet_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'worker' NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`public_ip` text,
	`wireguard_ip` text NOT NULL,
	`wireguard_public_key` text,
	`os` text,
	`arch` text,
	`agent_version` text,
	`last_heartbeat_at` integer,
	`desired_revision` integer DEFAULT 1 NOT NULL,
	`agent_token_hash` text,
	`applied_revision` integer,
	`deployment_revision` integer,
	`deployment_status` text DEFAULT 'unknown' NOT NULL,
	`deployment_error` text,
	`deployment_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`tailscale_ip` text,
	`expected_public_ip` text,
	`public_ip_status` text DEFAULT 'unknown' NOT NULL,
	`public_ip_checked_at` integer,
	`proxy_activation` text DEFAULT 'disabled' NOT NULL,
	`proxy_activation_reason` text,
	`provision_status` text DEFAULT 'pending' NOT NULL,
	`provision_error` text,
	`device_json` text,
	`runtime_json` text,
	`runtime_received_at` integer,
	`runtime_session_id` text,
	`runtime_sequence` integer DEFAULT 0 NOT NULL,
	`capacity_max_connections` integer,
	`overlay_approved` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_nodes_wireguard_ip_unique` ON `fleet_nodes` (`wireguard_ip`);--> statement-breakpoint
CREATE TABLE `fleet_proxy_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`username` text NOT NULL,
	`encrypted_password` text NOT NULL,
	`salt` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`rotated_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `fleet_proxy_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fleet_proxy_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`protocol` text NOT NULL,
	`listen_ip` text NOT NULL,
	`listen_port` integer NOT NULL,
	`egress_id` text,
	`username` text NOT NULL,
	`credential_ref` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`current_revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `fleet_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`egress_id`) REFERENCES `fleet_egresses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_fleet_endpoints_node` ON `fleet_proxy_endpoints` (`node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_proxy_endpoints_node_id_listen_ip_listen_port_unique` ON `fleet_proxy_endpoints` (`node_id`,`listen_ip`,`listen_port`);--> statement-breakpoint
CREATE TABLE `fleet_runtime_sessions` (
	`node_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `session_id`),
	FOREIGN KEY (`node_id`) REFERENCES `fleet_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
