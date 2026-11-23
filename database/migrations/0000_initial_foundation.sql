-- See docs/DATABASE_SCHEMA.md for index purposes and ordered column lists.
-- Build the parent and child indexes before adding foreign keys.
CREATE TABLE `audit_events` (
	`event_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`actor_user_id` char(36) character set ascii collate ascii_bin,
	`actor_role_id` char(36) character set ascii collate ascii_bin,
	`actor_role_code` varchar(64) character set ascii collate ascii_bin,
	`module` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`action` varchar(96) character set ascii collate ascii_bin NOT NULL,
	`entity_id` char(36) character set ascii collate ascii_bin,
	`entity_version` int unsigned,
	`request_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`result` varchar(16) character set ascii collate ascii_bin NOT NULL,
	`reason_code` varchar(96) character set ascii collate ascii_bin,
	`before_values` json,
	`after_values` json,
	`metadata` json,
	CONSTRAINT `pk_audit_events` PRIMARY KEY(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_outbox` (
	`event_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`actor_user_id` char(36) character set ascii collate ascii_bin,
	`actor_role_id` char(36) character set ascii collate ascii_bin,
	`actor_role_code` varchar(64) character set ascii collate ascii_bin,
	`module` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`action` varchar(96) character set ascii collate ascii_bin NOT NULL,
	`entity_id` char(36) character set ascii collate ascii_bin,
	`entity_version` int unsigned,
	`request_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`result` varchar(16) character set ascii collate ascii_bin NOT NULL,
	`reason_code` varchar(96) character set ascii collate ascii_bin,
	`before_values` json,
	`after_values` json,
	`metadata` json,
	`delivery_state` varchar(12) character set ascii collate ascii_bin NOT NULL DEFAULT 'pending',
	`next_attempt_at` datetime(3) NOT NULL,
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`lease_token` char(36) character set ascii collate ascii_bin,
	`lease_expires_at` datetime(3),
	`delivered_at` datetime(3),
	`last_error_code` varchar(96) character set ascii collate ascii_bin,
	CONSTRAINT `pk_audit_outbox` PRIMARY KEY(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `auth_throttles` (
	`counter_key` binary(32) NOT NULL,
	`window_started_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`blocked_until` datetime(3),
	CONSTRAINT `pk_auth_throttles` PRIMARY KEY(`counter_key`)
);
--> statement-breakpoint
CREATE TABLE `branches` (
	`id` char(36) character set ascii collate ascii_bin NOT NULL,
	`name` varchar(150) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `pk_branches` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `departments` (
	`id` char(36) character set ascii collate ascii_bin NOT NULL,
	`branch_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`name` varchar(150) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `pk_departments` PRIMARY KEY(`id`),
	CONSTRAINT `uq_departments_branch_id` UNIQUE(`branch_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` char(36) character set ascii collate ascii_bin NOT NULL,
	`employee_number` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`full_name` varchar(200) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`branch_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`department_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`job_title` varchar(150) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`joined_on` date NOT NULL,
	`employment_status` varchar(8) character set ascii collate ascii_bin NOT NULL,
	`mobile` varchar(32) character set utf8mb4 collate utf8mb4_bin,
	`email` varchar(254) character set utf8mb4 collate utf8mb4_bin,
	`biometric_number` varchar(64) character set utf8mb4 collate utf8mb4_bin,
	`residency_number` varchar(64) character set utf8mb4 collate utf8mb4_bin,
	`passport_number` varchar(64) character set utf8mb4 collate utf8mb4_bin,
	`nationality` varchar(100) character set utf8mb4 collate utf8mb4_bin,
	`residency_expires_on` date,
	`employee_number_key` varchar(64) character set utf8mb4 collate utf8mb4_bin GENERATED ALWAYS AS (lower(trim(`employee_number`))) VIRTUAL NOT NULL,
	`biometric_number_key` varchar(64) character set utf8mb4 collate utf8mb4_bin GENERATED ALWAYS AS (lower(trim(`biometric_number`))) VIRTUAL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `pk_employees` PRIMARY KEY(`id`),
	CONSTRAINT `uq_employees_employee_number` UNIQUE(`employee_number_key`),
	CONSTRAINT `uq_employees_biometric_number` UNIQUE(`biometric_number_key`)
);
--> statement-breakpoint
CREATE TABLE `numbering_counters` (
	`series_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`period_key` varchar(4) character set ascii collate ascii_bin NOT NULL,
	`last_value` bigint unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `pk_numbering_counters` PRIMARY KEY(`series_id`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `numbering_issuances` (
	`id` char(36) character set ascii collate ascii_bin NOT NULL,
	`series_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`period_key` varchar(4) character set ascii collate ascii_bin NOT NULL,
	`sequence_value` bigint unsigned NOT NULL,
	`formatted_number` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`config_snapshot` json NOT NULL,
	`issued_at` datetime(3) NOT NULL,
	`actor_user_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`action_key` varchar(96) character set ascii collate ascii_bin NOT NULL,
	`request_key` char(36) character set ascii collate ascii_bin NOT NULL,
	`payload_hash` binary(32) NOT NULL,
	`target_module` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`target_id` char(36) character set ascii collate ascii_bin NOT NULL,
	CONSTRAINT `pk_numbering_issuances` PRIMARY KEY(`id`),
	CONSTRAINT `uq_numbering_issuances_number` UNIQUE(`formatted_number`),
	CONSTRAINT `uq_numbering_issuances_sequence` UNIQUE(`series_id`,`period_key`,`sequence_value`),
	CONSTRAINT `uq_numbering_issuances_request` UNIQUE(`actor_user_id`,`action_key`,`request_key`)
);
--> statement-breakpoint
CREATE TABLE `numbering_series` (
	`id` char(36) character set ascii collate ascii_bin NOT NULL,
	`code` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`prefix` varchar(16) character set ascii collate ascii_bin NOT NULL,
	`format` varchar(100) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`padding_width` tinyint unsigned NOT NULL,
	`reset_policy` varchar(10) character set ascii collate ascii_bin NOT NULL,
	`enabled` boolean NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`created_by` char(36) character set ascii collate ascii_bin NOT NULL,
	`updated_by` char(36) character set ascii collate ascii_bin NOT NULL,
	CONSTRAINT `pk_numbering_series` PRIMARY KEY(`id`),
	CONSTRAINT `uq_numbering_series_code` UNIQUE(`code`),
	CONSTRAINT `uq_numbering_series_prefix` UNIQUE(`prefix`)
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`code` varchar(96) character set ascii collate ascii_bin NOT NULL,
	CONSTRAINT `pk_permissions` PRIMARY KEY(`code`)
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`permission_code` varchar(96) character set ascii collate ascii_bin NOT NULL,
	CONSTRAINT `pk_role_permissions` PRIMARY KEY(`role_id`,`permission_code`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` char(36) character set ascii collate ascii_bin NOT NULL,
	`code` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`name` varchar(150) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `pk_roles` PRIMARY KEY(`id`),
	CONSTRAINT `uq_roles_code` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` char(36) character set ascii collate ascii_bin NOT NULL,
	`token_hash` binary(32) NOT NULL,
	`user_id` char(36) character set ascii collate ascii_bin,
	`stage` varchar(16) character set ascii collate ascii_bin NOT NULL,
	`auth_version` int unsigned,
	`authenticated_at` datetime(3),
	`absolute_expires_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`last_activity_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `pk_sessions` PRIMARY KEY(`id`),
	CONSTRAINT `uq_sessions_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `user_permission_overrides` (
	`user_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`permission_code` varchar(96) character set ascii collate ascii_bin NOT NULL,
	`effect` varchar(5) character set ascii collate ascii_bin NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `pk_user_permission_overrides` PRIMARY KEY(`user_id`,`permission_code`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) character set ascii collate ascii_bin NOT NULL,
	`username` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`username_normalized` varchar(64) character set utf8mb4 collate utf8mb4_bin GENERATED ALWAYS AS (lower(trim(`username`))) VIRTUAL NOT NULL,
	`password_hash` varchar(512) character set ascii collate ascii_bin NOT NULL,
	`role_id` char(36) character set ascii collate ascii_bin NOT NULL,
	`account_status` varchar(8) character set ascii collate ascii_bin NOT NULL,
	`must_change_password` boolean NOT NULL,
	`auth_version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `pk_users` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_username_normalized` UNIQUE(`username_normalized`)
);
--> statement-breakpoint
CREATE INDEX `ix_audit_events_time` ON `audit_events` (`occurred_at`,`event_id`);
--> statement-breakpoint
CREATE INDEX `ix_audit_events_actor` ON `audit_events` (`actor_user_id`,`occurred_at`,`event_id`);
--> statement-breakpoint
CREATE INDEX `ix_audit_events_resource` ON `audit_events` (`module`,`entity_id`,`entity_version`,`occurred_at`,`event_id`);
--> statement-breakpoint
CREATE INDEX `ix_audit_outbox_delivery` ON `audit_outbox` (`delivery_state`,`next_attempt_at`,`event_id`);
--> statement-breakpoint
CREATE INDEX `ix_audit_outbox_lease` ON `audit_outbox` (`delivery_state`,`lease_expires_at`,`event_id`);
--> statement-breakpoint
CREATE INDEX `ix_auth_throttles_expiry` ON `auth_throttles` (`expires_at`,`counter_key`);
--> statement-breakpoint
CREATE INDEX `ix_employees_branch_number` ON `employees` (`branch_id`,`employee_number_key`);
--> statement-breakpoint
CREATE INDEX `ix_employees_branch_department_number` ON `employees` (`branch_id`,`department_id`,`employee_number_key`);
--> statement-breakpoint
CREATE INDEX `ix_numbering_issuances_target` ON `numbering_issuances` (`target_module`,`target_id`);
--> statement-breakpoint
CREATE INDEX `ix_role_permissions_permission` ON `role_permissions` (`permission_code`,`role_id`);
--> statement-breakpoint
CREATE INDEX `ix_sessions_user_expiry` ON `sessions` (`user_id`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `ix_sessions_expiry` ON `sessions` (`expires_at`,`id`);
--> statement-breakpoint
CREATE INDEX `ix_overrides_permission` ON `user_permission_overrides` (`permission_code`,`user_id`);
--> statement-breakpoint
CREATE INDEX `ix_users_role` ON `users` (`role_id`,`id`);
--> statement-breakpoint
ALTER TABLE `departments` ADD CONSTRAINT `fk_departments_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `fk_employees_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `fk_employees_department_branch` FOREIGN KEY (`branch_id`,`department_id`) REFERENCES `departments`(`branch_id`,`id`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `numbering_counters` ADD CONSTRAINT `fk_numbering_counter_series` FOREIGN KEY (`series_id`) REFERENCES `numbering_series`(`id`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `numbering_issuances` ADD CONSTRAINT `fk_numbering_issuance_counter` FOREIGN KEY (`series_id`,`period_key`) REFERENCES `numbering_counters`(`series_id`,`period_key`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `numbering_issuances` ADD CONSTRAINT `fk_numbering_issuance_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `fk_role_permissions_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `fk_role_permissions_permission` FOREIGN KEY (`permission_code`) REFERENCES `permissions`(`code`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `user_permission_overrides` ADD CONSTRAINT `fk_overrides_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `user_permission_overrides` ADD CONSTRAINT `fk_overrides_permission` FOREIGN KEY (`permission_code`) REFERENCES `permissions`(`code`) ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `fk_users_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE restrict ON UPDATE restrict;
