ALTER TABLE `request_correlations` ADD CONSTRAINT `correlation_not_self` CHECK (`request_correlations`.`downstream_usage_id` <> `request_correlations`.`upstream_usage_id`);--> statement-breakpoint
ALTER TABLE `station_relations` ADD CONSTRAINT `station_relation_not_self` CHECK (`station_relations`.`downstream_id` <> `station_relations`.`upstream_id`);--> statement-breakpoint
CREATE INDEX `price_effective` ON `model_pricing` (`station_id`,`model`,`effective_at`);--> statement-breakpoint
CREATE INDEX `usage_time` ON `usage_records` (`occurred_at`,`station_id`);--> statement-breakpoint
CREATE INDEX `usage_request` ON `usage_records` (`station_id`,`request_id`);