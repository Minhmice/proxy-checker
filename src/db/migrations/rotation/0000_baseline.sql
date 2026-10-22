CREATE TABLE `antigravity_account_turns` (
	`account_id` text PRIMARY KEY NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`last_activated_at` integer
);
