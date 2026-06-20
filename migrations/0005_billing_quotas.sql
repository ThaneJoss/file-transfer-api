ALTER TABLE `usage_event`
  RENAME COLUMN `bytes` TO `quantity`;

ALTER TABLE `usage_event`
  ADD COLUMN `unit` text DEFAULT 'bytes' NOT NULL;

ALTER TABLE `usage_event`
  ADD COLUMN `idempotency_key` text;

CREATE UNIQUE INDEX `usage_event_idempotency_key_unique`
  ON `usage_event` (`idempotency_key`);

CREATE TABLE `user_quota` (
  `user_id` text NOT NULL,
  `service` text NOT NULL,
  `unit` text NOT NULL,
  `limit_value` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`user_id`, `service`, `unit`),
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `user_quota_service_unit_idx`
  ON `user_quota` (`service`, `unit`);
