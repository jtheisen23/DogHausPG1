# Dog Haus PG1 Dashboard

A multi-location dashboard for Dog Haus PG1. It shows sales, discounts & comps, labor and menu items,
lets you compare locations and time periods, and controls who can see what. Data comes from the
**Toast API**, logins go through **Cloudflare Access**, and it runs on Cloudflare's $5/month
Workers Paid plan (everything else is free).

| Tab | What you get |
|---|---|
| **Overview** | KPIs (net sales, orders, avg check, guests, discounts, labor $, labor %, sales per labor hour), each with change vs. the comparison period. Trend chart by day/week/month (total vs. comparison, or one line per location), plus a location summary table |
| **Compare locations** | Full scorecard (net/day, avg check, per guest, discount %, voids, labor %, SPLH, OT), location-vs-location bars for any metric, average day by weekday, and average sales by hour |
| **Sales mix** | Sales category, dining option (dine in / take out / online / 3rd party) and revenue center, with share of sales by location and change vs. the comparison period |
| **Discounts & comps** | Totals, % of gross, top discounts vs. comparison, discount % by location and over time, a discount × location table, and **comps by approving manager** |
| **Labor** | Labor $, labor %, hours, OT, SPLH, labor $ per guest. Trend by location, and breakdowns by location and by job |
| **Menu items** | Top items with quantity, net sales, average price and change |
| **Admin** | Add users and choose which **locations** and **sections** (sales, discounts, labor, items) each one can see. Every change is written to an audit log |

The filters apply to every tab. **Date range** presets: today, yesterday, last 7/30/90/365 days,
week/month/quarter/year to date, last week/month/quarter/year, or a custom range. **Compare to**:
same period last year matched by weekday (the default: a Saturday is compared with a Saturday),
the same calendar dates last year, the prior week on the same weekdays (ranges longer than a week go
back as many whole weeks as they need not to overlap), or a custom range. You can also group by
day/week/month and pick locations (Alt/⌘-click shows only that location). The filters are saved
in the URL, so a bookmarked or shared link opens the same view. Every table can be sorted and
exported to CSV. Light and dark mode are both supported.

## Architecture

```
 Toast API ──(hourly, GitHub Actions)────▶ etl/ (Node, no dependencies)
                                               │ daily aggregates
                                               ▼
 Browser ──▶ Cloudflare Access (login) ──▶ Cloudflare Worker ──▶ Cloudflare D1 (SQLite)
             email PIN / Google / MS        /api/* + permission      sales, mix, items,
                                            checks, static UI        discounts, labor, users
```

- **Cloudflare Access** (Zero Trust, free for up to 50 users) decides who can sign in.
- The **Worker** checks the Access JWT itself, then looks the email up in the `users` table to
  decide which locations and sections that person can see. These rules are enforced in the API,
  not only hidden in the UI. Someone who gets past Access but isn't in the table still gets a 403.
- **D1** stores *daily aggregates*, not raw checks. That keeps queries fast and the database
  small. The Workers Paid plan includes 50M D1 rows written per month; the regular syncs use
  about 1.2M.
- The **ETL** runs in **GitHub Actions** (free), not in a Worker cron. It was built for the
  Workers free plan, which only allows 10 ms of CPU per run: not enough for a day of Toast orders.
- The **UI** is plain HTML/JS with [Apache ECharts](https://echarts.apache.org) (Apache-2.0),
  served locally from `public/vendor`. There's no build step.

Why not Metabase, Grafana or Superset? They all need a server you run and pay for. Metabase's
per-location row permissions ("sandboxing") are also a paid feature. This stack costs $0 and
enforces per-location permissions itself.

## Try it locally with demo data

```bash
npm install
cp .dev.vars.example .dev.vars          # AUTH_MODE=dev signs you in as DEV_USER_EMAIL
npm run db:migrate:local
npm run demo:seed                       # ~2 years of fake data for 3 demo locations
npm run dev                             # http://localhost:8787
```

To test a restricted user, change `DEV_USER_EMAIL` in `.dev.vars` to `dt.manager@example.com`
(a demo viewer who can only see Downtown) and restart `npm run dev`.

The header logo is `public/logo.png`, the browser-tab icon `public/favicon.png` and the phone
home-screen icon `public/apple-touch-icon.png`, all made from `assets/brand/dog-haus-logo-source.jpeg`.
The colors follow the logo: its tan (`--brand`) and a deeper gold of the same hue for links and
buttons (`--accent`), with location colors `--s1`…`--s8` starting from that gold (`public/styles.css`).

## Production setup

### 1. Toast API credentials
1. In Toast Web, go to **Integrations → Toast API access** and create a *Standard API access*
   credential with **read-only** scopes for orders, labor (including employees and jobs),
   configuration and restaurants. If your account doesn't show API access, ask your Toast rep to
   enable it.
2. Note the **client ID** and **client secret**, and each location's **restaurant GUID**.
3. Copy `config/locations.example.json` and fill in one entry per location. `id` is a short code
   such as `HB` that the dashboard uses in permissions. `salariedLaborPerDay` (optional) adds
   salaried managers' daily cost to labor (e.g. the location's salaried pay per year ÷ 365). With
   7shifts it's only a fallback: salaried pay then comes from the managers' 7shifts wages.

### 2. Cloudflare database and Worker
```bash
npx wrangler login
npx wrangler d1 create doghaus-pg1      # copy the database_id into wrangler.toml
npm run db:migrate:remote
```
Run `npm run deploy`, or connect the repo under *Workers & Pages → Create → Import a repository*
(project name `doghaus-pg1`, matching `name` in `wrangler.toml`; deploy command `npx wrangler deploy`)
so every push to `main` deploys. In the Worker's
**Settings → Build → Branch control**, turn **off** builds for preview (non-production)
branches: they fail, and preview URLs can't sign in through Access anyway. Only `main` deploys. Then, in the Worker's
**Settings → Variables and Secrets**, add a **secret** `BOOTSTRAP_ADMINS` with your email, so you
can't lock yourself out. `keep_vars = true` in `wrangler.toml` stops deploys from erasing it.
The `Database migrations` GitHub workflow creates or updates the tables using the secrets from step 4. The dashboard is at `https://doghaus-pg1.doghauspg1.workers.dev`.
You can add a custom domain later under the Worker's **Settings → Domains & Routes**.

### 3. Cloudflare Access (logins)
1. In the Cloudflare dashboard, open **Zero Trust**. Pick a team name (for example `doghaus-pg1`),
   which gives you `doghaus-pg1.cloudflareaccess.com`, and choose the Free plan.
2. Under **Settings → Authentication**, add login methods. *One-time PIN* (a code sent by
   email) works for everyone; Google or Microsoft are optional.
3. Under **Access → Applications → Add an application → Self-hosted**, enter the dashboard's
   hostname. Add an **Allow** policy that lists the emails (or email domain) allowed to sign in.
   You can also turn on Access from the Worker's **Settings → Domains & Routes** page.
4. Copy the application's **Audience (AUD) tag**. In `wrangler.toml`, set `ACCESS_AUD` to that tag
   and `ACCESS_TEAM_DOMAIN = "doghaus-pg1.cloudflareaccess.com"`, then run `npm run deploy` again.

Until both values are set (the `REPLACE_…` placeholders count as unset), the API refuses every
request (it fails closed).

### 4. Scheduled sync (GitHub Actions)
Under **Settings → Secrets and variables → Actions**, add these repository secrets:

| Secret | Value |
|---|---|
| `TOAST_CLIENT_ID` / `TOAST_CLIENT_SECRET` | From step 1 |
| `LOCATIONS_JSON` | The contents of your filled-in locations JSON |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages (right sidebar) |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → Create token → Custom, permission **Account · D1 · Edit** |
| `D1_DATABASE_ID` | The `database_id` from step 2 |

Optional repository variables: `TOAST_API_HOST` (defaults to `https://ws-api.toasttab.com`)
and `OVERTIME_MULTIPLIER` (defaults to `1.5`).

**Test Toast first:** once the `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET` and `LOCATIONS_JSON`
secrets are set, run *Actions → Toast connection check*. It signs in and reads one day for each
location, then reports net sales, labor and any missing Toast permissions in the run summary. It
writes nothing and doesn't need the Cloudflare secrets.

`.github/workflows/toast-sync.yml` refreshes today hourly, started by the Worker's cron trigger (see *Reliable scheduling* below). Each morning it
also re-syncs the last 7 days, so late edits and tip adjustments are picked up. **History** is
loaded by `.github/workflows/toast-backfill.yml`. Every night it works backwards from the
earliest loaded day toward its `from` date (default 2025-01-01), and stops after 1,000,000 D1
rows written: enough for a full history (about 110 rows per location-day) in one run of
2–3 hours. That relies on the Workers Paid plan. On the free plan (100k rows written/day, of which
the regular syncs use about 40,000 with 7 locations) run it with `max_rows` 40000. Once history is complete it does nothing. To
go further back, run *Actions → Toast history backfill → Run workflow* with an earlier date. For a
one-off date range, use *Toast sync → Run workflow* with a start and end date. Tick
*revenue_centers_only* to rewrite only the revenue center numbers for that range: a few dozen D1
rows per location-day instead of several hundred, for re-pulling history after a change to how
revenue centers are assigned.

You can also run the sync by hand: `node etl/src/index.js --start 2025-01-01 --end 2025-06-30`
with the same environment variables set. Add `--out file.sql` to write SQL to a file instead of
sending it to D1.

**Reliable scheduling:** GitHub's free scheduler often skips runs, so the Worker's cron triggers
(`[triggers]` in `wrangler.toml`) start the sync instead: hourly at :17, plus 8:40 UTC (4:40am
Eastern, 3:40am in winter) for the 7-day recheck. Hourly runs between midnight and 6am Eastern
also finish the previous day. They need a Worker **secret** `GITHUB_DISPATCH_TOKEN`: a fine-grained GitHub
token limited to this repository with **Actions: Read and write** permission. GitHub's own
schedule keeps only the 8:40 UTC 7-day re-sync as a backup.

**Where labor comes from:** until the `SEVENSHIFTS_ACCESS_TOKEN` secret is set, **actual labor**
(the Labor tab, labor %, SPLH) comes from **Toast time entries**: hours × each entry's hourly wage,
overtime at `OVERTIME_MULTIPLIER` (1.5×), by Toast job, plus `salariedLaborPerDay` if a location sets
it (Toast doesn't know salaried pay). Once the token is set, the Toast sync and backfill skip labor
and it comes only from 7shifts, as described below. Days loaded before then keep their Toast labor
until 7shifts re-syncs them: run *Toast sync* with *sevenshifts_only* ticked and a start date such as
2025-01-01.

**7shifts:** with 7shifts, **actual labor** comes from **7shifts time punches** and only from them.
Each sync rewrites labor for every synced day from 7shifts (a day without punches has no hourly labor). The *7shifts* tab (users with the **7shifts** box ticked in
Admin, for their own locations; labor and sales figures follow the Labor and Sales permissions)
compares scheduled labor from 7shifts with actual labor and shows the next 14 days of schedule.
Salaried people (7shifts wage type not hourly, e.g. General Managers) count toward scheduled and
actual hours, as in 7shifts, but their pay isn't hours × wage; their hours past 40 a week count as
overtime hours (as 7shifts counts them) without any overtime pay. Their
pay is spread the way 7shifts spreads it in Daily Sales & Labor: the weekly salary (annual ÷ 52)
is split across locations by the wage's allocations (or by where they worked that week), then
evenly over its allocation days, whether or not they work them. It's counted for each workweek a
salaried person worked or was scheduled, and shows under their role (e.g. General Manager). It
replaces `salariedLaborPerDay`, which is used only when 7shifts has no salaries. The sync log
shows hourly pay only, because the log is public.

**Totals match 7shifts exactly.** Each sync also reads 7shifts' own Daily Sales & Labor report
(The Works plan or higher) and matches every location's daily totals to it: actual hours,
overtime hours and labor $, and scheduled hours and labor $. The breakdown by role still comes
from punches, shifts and wages; a *7shifts adjustment* row per day carries the difference. It's
mostly salaried pay that 7shifts books somewhere other than where the manager worked (for example
salaried wages without a location allocation in 7shifts). Giving every salaried wage a location
allocation in 7shifts keeps the adjustment small. Days the report doesn't cover keep the
dashboard's own calculation. Overtime weeks start on Monday unless the repository variable
`SEVENSHIFTS_WEEK_START` says otherwise (0 = Sunday). To load 7shifts history (schedule,
labor and log book), run *Toast sync* with *sevenshifts_only* and *logbook_all* ticked and a start
date such as 2025-01-01. Add a GitHub secret
`SEVENSHIFTS_ACCESS_TOKEN` (7shifts → Settings → Developer tools → Access tokens); each Toast sync
then also loads published shifts for the last few days and the next 14. Run *Actions → 7shifts
connection check* to confirm the token, how 7shifts locations match the dashboard's, what a
week of time punches looks like, and how the last 7 days' hours and sales compare with 7shifts' own
Daily Sales & Labor report (no dollar amounts are printed, since the log is public; names are matched; add `"sevenShiftsId": <id>` to a location in `LOCATIONS_JSON` to pin one). File Toast jobs
under 7shifts roles in *Admin → Category groups → Labor jobs*; the Labor and 7shifts tabs then group
jobs by role (each role expands to its jobs). The tab also has a **Log book** section with every
7shifts log book entry for the user's assigned locations, filterable by location, category and
text. Each sync refreshes recent days; run *Toast sync* with *logbook_all* ticked to reload all history.
Attachments open through the Worker, which needs the same token as a Worker **secret**
`SEVENSHIFTS_ACCESS_TOKEN` (Workers & Pages → doghaus-pg1 → Settings → Variables and Secrets).

> GitHub pauses scheduled workflows after 60 days with no activity in the repo. If that happens,
> re-enable the workflow from the Actions tab.

### 5. Give people access
Sign in as a bootstrap admin, open **Admin → Add user**, and enter the email the person will
sign in with. Then choose:
- **Role**: *Admin* sees everything and can manage users. *Viewer* sees only what's ticked.
- **Locations**: specific locations, or *All locations*, which also covers locations you add later.
- **Sections**: Sales, Discounts & comps, Labor, Menu items. A viewer without Labor never gets
  labor data from the API, and one without Discounts gets sales numbers with gross/discount/void
  fields removed.

The users list shows each person's **last sign-in**: when they last signed in through Cloudflare
Access to open the dashboard, in your local time ("Never" if they haven't yet).

**Category groups** (Admin tab): combine Toast sales categories, dining options, revenue
centers or discount names into reporting groups, e.g. "Draft", "Draft Beer" and "HH Draft" → "Beer". Groups are
applied when the dashboard reads data, so they cover all history immediately and never change the
stored Toast data.

**Sign-in access is updated for you.** Saving a user in Admin also adds their email to the
Cloudflare Access policy *Dog Haus PG1 dashboard users*, so they can sign in right away; disabling or
removing them takes it out again. Admins in `BOOTSTRAP_ADMINS` always stay in. The Admin page
shows the result after each save, and if Cloudflare refuses the update the user is still saved
and the message says why. Rules in that policy other than individual emails (for example
*Emails ending in*) are left alone, but individual emails added there by hand are replaced by the
dashboard's list, so manage people in Admin only.

This needs a Worker **secret** `ACCESS_POLICY_TOKEN`: in Cloudflare, *Manage account → Account
API tokens → Create token*, permission **Access: Apps and Policies → Edit** on this account. The
policy name and account ID are `ACCESS_POLICY_NAME` and `CLOUDFLARE_ACCOUNT_ID` in
`wrangler.toml`. Without the secret, nothing changes in Cloudflare and people also have to be
added to the Access policy (step 3) by hand.

## How numbers are calculated

| Metric | Definition |
|---|---|
| Gross sales | Pre-discount price of every non-voided item. Gift card sales/reloads and house-account payments are excluded, as in Toast |
| Discounts | Item-level plus check-level discounts and comps |
| Net sales | Gross sales − discounts. Tax, tips and service charges are tracked separately |
| Voids | Value of voided items, checks and orders |
| Avg check | Net sales ÷ orders |
| Labor $ | From hourly 7shifts time punches: paid hours (clock-out − clock-in − unpaid breaks) × wage, with hours past 40 per employee per Monday–Sunday week (all locations) as overtime × wage × 1.5, plus salaried managers' pay from their 7shifts wages (weekly salary spread over their allocation days and locations, as 7shifts does). Salaried people's punches add hours (past 40 a week, overtime hours) but no hours × wage cost. Each day's total is then matched to 7shifts' Daily Sales & Labor (the *7shifts adjustment* row). Toast time entries are not used |
| Labor % | Labor $ ÷ net sales |
| SPLH | Net sales ÷ labor hours |
| Hour of day | Hour the order was opened, in the location's time zone |
| Revenue center | The order's revenue center in Toast. Orders Toast saved without one (for example DoorDash orders sent in before the integration had a revenue center) go to the revenue center whose name starts their dining option's name ("DoorDash - Delivery" → DoorDash); the rest show as Unspecified |
| Item sales | Check-level discounts are spread across the items on each check, so item totals add up to net sales |

When you first connect Toast, compare one day per location against Toast's **Sales Summary**
report. If your Toast setup counts something differently (for example, service charges inside
net sales), adjust `etl/src/transform.js`.

## Project layout

```
db/migrations/     D1 schema (aggregates + users/permissions + audit log)
etl/src/           Toast client, transforms, SQL builder, sync CLI, demo-data generator
worker/src/        Cloudflare Worker: Access JWT check, permissions, JSON API, admin API
public/            Dashboard UI (HTML/CSS/JS + vendored ECharts)
.github/workflows  Scheduled Toast sync, CI tests
```

`npm test` runs unit tests for the Toast transforms, SQL escaping and Access JWT verification.
