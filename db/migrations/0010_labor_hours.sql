-- Hours on the clock per local date, hour and job, from Toast time entries
-- (Kitchen tab: "By hour: demand, staffing & ticket time"). Each shift is
-- split across clock hours by the fraction worked. business_date is the
-- Toast business date the time entries were read for (rows are replaced per
-- location and business date); local_date/hour are where the time fell.
CREATE TABLE labor_hours (
  location_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  local_date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  job_title TEXT NOT NULL,
  hours REAL NOT NULL,
  PRIMARY KEY (location_id, business_date, local_date, hour, job_title)
) WITHOUT ROWID;
