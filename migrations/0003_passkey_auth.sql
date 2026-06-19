CREATE TABLE `passkey` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text,
  `public_key` text NOT NULL,
  `user_id` text NOT NULL,
  `credential_id` text NOT NULL,
  `counter` integer NOT NULL,
  `device_type` text NOT NULL,
  `backed_up` integer NOT NULL,
  `transports` text,
  `created_at` integer,
  `aaguid` text,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `passkey_user_id_idx` ON `passkey` (`user_id`);
CREATE UNIQUE INDEX `passkey_credential_id_unique` ON `passkey` (`credential_id`);

CREATE TABLE `passkey_registration_context` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `expires_at` integer NOT NULL,
  `used_at` integer,
  `created_at` integer NOT NULL
);

CREATE UNIQUE INDEX `passkey_registration_context_user_id_unique`
  ON `passkey_registration_context` (`user_id`);
CREATE INDEX `passkey_registration_context_expires_at_idx`
  ON `passkey_registration_context` (`expires_at`);
