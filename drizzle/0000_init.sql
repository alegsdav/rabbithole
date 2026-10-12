CREATE TABLE `channel_lanes` (
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`lane_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`thumb_url` text,
	`uploads_playlist_id` text,
	`source` text DEFAULT 'llm' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `channel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lane_id`) REFERENCES `lanes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `channel_lanes_lane_idx` ON `channel_lanes` (`lane_id`);--> statement-breakpoint
CREATE TABLE `feed_items` (
	`user_id` text NOT NULL,
	`video_id` text NOT NULL,
	`lane_id` text NOT NULL,
	`title` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_title` text NOT NULL,
	`thumb_url` text NOT NULL,
	`published_at` integer NOT NULL,
	`duration_sec` integer,
	`view_count` integer,
	`is_live` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `video_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lane_id`) REFERENCES `lanes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_items_lane_idx` ON `feed_items` (`lane_id`,`score`);--> statement-breakpoint
CREATE TABLE `lanes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer NOT NULL,
	`search_queries` text DEFAULT '[]' NOT NULL,
	`last_refreshed_at` integer,
	`last_error` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lanes_user_idx` ON `lanes` (`user_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `quota_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`user_id` text,
	`method` text NOT NULL,
	`units` integer NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quota_log_day_idx` ON `quota_log` (`day`);--> statement-breakpoint
CREATE TABLE `routing_corrections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`query` text NOT NULL,
	`lane_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lane_id`) REFERENCES `lanes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `search_cache` (
	`user_id` text NOT NULL,
	`query_key` text NOT NULL,
	`results` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_cache_key` ON `search_cache` (`user_id`,`query_key`);--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`video_id` text NOT NULL,
	`channel_id` text,
	`lane_id` text,
	`kind` text NOT NULL,
	`value` real DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `signals_user_channel_idx` ON `signals` (`user_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `signals_user_video_idx` ON `signals` (`user_id`,`video_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text,
	`name` text,
	`image` text,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`token_expires_at` integer,
	`scope` text,
	`settings` text DEFAULT '{"hideShorts":true}' NOT NULL,
	`subscriptions_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);