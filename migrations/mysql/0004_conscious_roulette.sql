CREATE TABLE `mcp_keys` (
	`id` varchar(64) NOT NULL,
	`name` varchar(100) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`prefix` varchar(24) NOT NULL,
	`created_at` varchar(32) NOT NULL,
	`expires_at` varchar(32) NOT NULL,
	`last_used_at` varchar(32),
	`revoked_at` varchar(32),
	CONSTRAINT `mcp_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `mcp_key_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `upstream_accounts` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`external_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`platform` varchar(64) NOT NULL,
	`type` varchar(64) NOT NULL,
	`base_url` varchar(512),
	`key_present` boolean,
	`status` varchar(64) NOT NULL,
	`schedulable` boolean,
	`checked_at` varchar(32),
	`check_result` json,
	`observed_at` varchar(32) NOT NULL,
	CONSTRAINT `upstream_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `account_station_external` UNIQUE(`station_id`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `upstream_accounts` ADD CONSTRAINT `upstream_accounts_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE cascade ON UPDATE no action;