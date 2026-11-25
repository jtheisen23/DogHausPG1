-- Per-user permission for the Kitchen tab (ticket times, staffing, order
-- heatmaps). Until now the tab came with Sales, so everyone who has Sales keeps
-- it; new users get it only when ticked. Admins always have it.
ALTER TABLE users ADD COLUMN can_kitchen INTEGER NOT NULL DEFAULT 0;
UPDATE users SET can_kitchen = can_sales;
