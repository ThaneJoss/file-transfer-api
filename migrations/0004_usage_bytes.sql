DELETE FROM `usage_event`
WHERE `action` NOT LIKE '%.bytes';

ALTER TABLE `usage_event`
  RENAME COLUMN `quantity` TO `bytes`;
