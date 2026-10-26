CREATE TABLE `usage_aggregates` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`day` varchar(255) NOT NULL,
	`data` json NOT NULL,
	`observed_at` varchar(32) NOT NULL,
	CONSTRAINT `usage_aggregates_id` PRIMARY KEY(`id`),
	CONSTRAINT `agg_station_day` UNIQUE(`station_id`,`day`)
);
--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64),
	`type` varchar(255) NOT NULL,
	`threshold` decimal(30,12) NOT NULL,
	`cooldown` int NOT NULL,
	`enabled` boolean NOT NULL,
	CONSTRAINT `alert_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alert_events` (
	`id` varchar(64) NOT NULL,
	`rule_id` varchar(64),
	`station_id` varchar(64),
	`type` varchar(255) NOT NULL,
	`message` text NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` varchar(32) NOT NULL,
	CONSTRAINT `alert_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` varchar(64) NOT NULL,
	`action` varchar(255) NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`details` json,
	`created_at` varchar(32) NOT NULL,
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `station_capabilities` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL,
	`http_status` int,
	`message` text NOT NULL,
	`checked_at` varchar(32) NOT NULL,
	CONSTRAINT `station_capabilities_id` PRIMARY KEY(`id`),
	CONSTRAINT `cap_station_name` UNIQUE(`station_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `request_correlations` (
	`id` varchar(64) NOT NULL,
	`downstream_usage_id` varchar(64) NOT NULL,
	`upstream_usage_id` varchar(64) NOT NULL,
	`method` varchar(255) NOT NULL,
	`created_at` varchar(32) NOT NULL,
	CONSTRAINT `request_correlations_id` PRIMARY KEY(`id`),
	CONSTRAINT `correlation_down` UNIQUE(`downstream_usage_id`),
	CONSTRAINT `correlation_up` UNIQUE(`upstream_usage_id`)
);
--> statement-breakpoint
CREATE TABLE `station_credentials` (
	`station_id` varchar(64) NOT NULL,
	`encrypted` text NOT NULL,
	`masked` varchar(255) NOT NULL,
	CONSTRAINT `station_credentials_station_id` PRIMARY KEY(`station_id`)
);
--> statement-breakpoint
CREATE TABLE `exchange_rates` (
	`id` varchar(64) NOT NULL,
	`from_currency` varchar(3) NOT NULL,
	`to_currency` varchar(3) NOT NULL,
	`rate` decimal(30,12) NOT NULL,
	`effective_at` varchar(32) NOT NULL,
	`source` varchar(255) NOT NULL,
	CONSTRAINT `exchange_rates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`model` varchar(255) NOT NULL,
	`source` varchar(255) NOT NULL,
	`observed_at` varchar(32) NOT NULL,
	CONSTRAINT `models_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_station` UNIQUE(`station_id`,`model`)
);
--> statement-breakpoint
CREATE TABLE `model_pricing` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`model` varchar(255) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`buy` json NOT NULL,
	`sell` json NOT NULL,
	`multiplier` decimal(30,12) NOT NULL,
	`effective_at` varchar(32) NOT NULL,
	`source` varchar(255) NOT NULL,
	`created_at` varchar(32) NOT NULL,
	CONSTRAINT `model_pricing_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recharge_records` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`amount` decimal(30,12) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`occurred_at` varchar(32) NOT NULL,
	`note` text NOT NULL,
	CONSTRAINT `recharge_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `station_relations` (
	`id` varchar(64) NOT NULL,
	`downstream_id` varchar(64) NOT NULL,
	`upstream_id` varchar(64) NOT NULL,
	CONSTRAINT `station_relations_id` PRIMARY KEY(`id`),
	CONSTRAINT `relation_pair` UNIQUE(`downstream_id`,`upstream_id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(64) NOT NULL,
	`expires_at` bigint unsigned NOT NULL,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` varchar(191) NOT NULL,
	`value` json NOT NULL,
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `stations` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`base_url` varchar(255) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`auth_type` varchar(32) NOT NULL,
	`role` varchar(32) NOT NULL,
	`cost_mode` varchar(32) NOT NULL DEFAULT 'token',
	`currency` varchar(3) NOT NULL DEFAULT 'USD',
	`notes` varchar(2000) NOT NULL DEFAULT '',
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`version` varchar(255),
	`last_sync` varchar(32),
	`latency` int,
	`checkpoint` varchar(32),
	`snapshot` json,
	`created_at` varchar(32) NOT NULL,
	CONSTRAINT `stations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`amount` decimal(30,12) NOT NULL,
	`other_fees` decimal(30,12) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`start` varchar(32) NOT NULL,
	`end` varchar(32) NOT NULL,
	`quota` decimal(30,12),
	`used` decimal(30,12),
	`created_at` varchar(32) NOT NULL,
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL,
	`started_at` varchar(32) NOT NULL,
	`finished_at` varchar(32),
	`message` text,
	`count` int NOT NULL DEFAULT 0,
	`queue_job_id` varchar(128),
	`attempt` int NOT NULL DEFAULT 0,
	CONSTRAINT `sync_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_transactions` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`amount` decimal(30,12) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`occurred_at` varchar(32) NOT NULL,
	`note` text NOT NULL,
	`fx_id` varchar(64),
	CONSTRAINT `financial_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` varchar(64) NOT NULL,
	`station_id` varchar(64) NOT NULL,
	`external_id` varchar(255) NOT NULL,
	`request_id` varchar(255),
	`upstream_request_id` varchar(255),
	`model` varchar(255) NOT NULL,
	`input` bigint unsigned,
	`output` bigint unsigned,
	`cache_read` bigint unsigned,
	`cache_creation` bigint unsigned,
	`actual_cost` decimal(30,12),
	`currency` varchar(3) NOT NULL,
	`duration` int,
	`first_token` int,
	`success` boolean,
	`occurred_at` varchar(32) NOT NULL,
	`price_id` varchar(64),
	`estimated_cost` decimal(30,12),
	`estimated_revenue` decimal(30,12),
	`fx_id` varchar(64),
	`billing_mode` varchar(32) NOT NULL DEFAULT 'token',
	CONSTRAINT `usage_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `usage_external` UNIQUE(`station_id`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `usage_aggregates` ADD CONSTRAINT `usage_aggregates_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alert_rules` ADD CONSTRAINT `alert_rules_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alert_events` ADD CONSTRAINT `alert_events_rule_id_alert_rules_id_fk` FOREIGN KEY (`rule_id`) REFERENCES `alert_rules`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alert_events` ADD CONSTRAINT `alert_events_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `station_capabilities` ADD CONSTRAINT `station_capabilities_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_correlations` ADD CONSTRAINT `request_correlations_downstream_usage_id_usage_records_id_fk` FOREIGN KEY (`downstream_usage_id`) REFERENCES `usage_records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_correlations` ADD CONSTRAINT `request_correlations_upstream_usage_id_usage_records_id_fk` FOREIGN KEY (`upstream_usage_id`) REFERENCES `usage_records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `station_credentials` ADD CONSTRAINT `station_credentials_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `models` ADD CONSTRAINT `models_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_pricing` ADD CONSTRAINT `model_pricing_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `recharge_records` ADD CONSTRAINT `recharge_records_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `station_relations` ADD CONSTRAINT `station_relations_downstream_id_stations_id_fk` FOREIGN KEY (`downstream_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `station_relations` ADD CONSTRAINT `station_relations_upstream_id_stations_id_fk` FOREIGN KEY (`upstream_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD CONSTRAINT `sync_jobs_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_transactions` ADD CONSTRAINT `financial_transactions_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_records` ADD CONSTRAINT `usage_records_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_records` ADD CONSTRAINT `usage_records_price_id_model_pricing_id_fk` FOREIGN KEY (`price_id`) REFERENCES `model_pricing`(`id`) ON DELETE no action ON UPDATE no action;