CREATE TABLE `usage_event` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `service` text NOT NULL,
  `action` text NOT NULL,
  `quantity` integer DEFAULT 1 NOT NULL,
  `metadata` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `usage_event_user_created_at_idx`
  ON `usage_event` (`user_id`, `created_at`);

CREATE INDEX `usage_event_service_created_at_idx`
  ON `usage_event` (`service`, `created_at`);
