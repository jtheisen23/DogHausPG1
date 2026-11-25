-- Kitchen ticket time per order, for the Kitchen tab's heatmap: minutes from
-- the first item fired to the last item marked READY on the Toast KDS, with
-- the local weekday (Monday = 0) and hour the order was opened. Only orders
-- whose kitchen bumped them on the KDS have a row.
CREATE TABLE ticket_times (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  order_guid    TEXT NOT NULL,
  weekday       INTEGER NOT NULL,
  hour          INTEGER NOT NULL,
  minutes       REAL NOT NULL,
  PRIMARY KEY (location_id, business_date, order_guid)
) WITHOUT ROWID;
