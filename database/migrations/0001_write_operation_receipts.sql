-- Additive migration only. See docs/DATABASE_SCHEMA.md for deployment and index verification.
-- Build the explicit child index before adding the foreign key to avoid an implicit duplicate.
CREATE TABLE `write_operation_receipts` (
	`operation_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`actor_user_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`operation_code` varchar(96) character set ascii collate ascii_bin NOT NULL,
	`input_hash` binary(32) NOT NULL,
	`reservation_token` char(36) character set ascii collate ascii_bin NOT NULL,
	`response_json` json,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `pk_write_operation_receipts` PRIMARY KEY(`operation_id`)
);
--> statement-breakpoint
CREATE INDEX `ix_write_operation_receipts_actor` ON `write_operation_receipts` (`actor_user_id`);
--> statement-breakpoint
ALTER TABLE `write_operation_receipts` ADD CONSTRAINT `fk_write_operation_receipts_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE restrict;
