# ScholarSched System Overview

**Review date:** 2026-11-17
**Reviewed branch:** `codex/scholarsched-scheduling-features`
**Reviewed commit:** `753af80 Adjust course form spacing`
**Repository state:** Feature implementation in progress; changes are uncommitted.
**Scope:** Feature implementation and source review. Database changes are provided as migration v4 and have not been applied to a Supabase project.

## Executive summary

ScholarSched is a small static web application for manually building and publishing college schedules. The browser uses Supabase Auth and the Supabase JavaScript client directly; PostgreSQL functions, triggers, constraints, views, and Row Level Security provide the backend rules. There is no separate application server, build pipeline, or automated test runner in the repository.

The feature branch now also includes Program Head room/period management, atomic period copying, a weekly timetable for students and teachers, CSV/PDF/calendar exports, bulk publish controls, and room/time suggestions. The v4 database migration is required for period lifecycle/copy RPCs and conflict suggestions. The front end is static HTML/JavaScript and talks directly to Supabase; the current work has not been applied to a live or test Supabase project.

The implementation should be verified against a disposable Supabase project before release. SQL migration history remains a sequence of standalone scripts rather than a standard Supabase migrations directory.

## System architecture and stack

- **Frontend:** Static HTML, CSS, and browser JavaScript in `public/`; no framework or compile step.
- **Backend:** Supabase Auth and PostgreSQL accessed directly from `public/js/schedules.js` using the UMD Supabase JS client loaded from jsDelivr (`@supabase/supabase-js@2.45.4`).
- **Authorization:** `profiles.role` identifies `admin` (Program Head) and `teacher`; database RLS and security-checked RPCs enforce access. Students are anonymous and have no account.
- **Hosting:** Static-host compatible. The root `index.html` redirects to `public/`.
- **Dependencies and tests:** No `package.json`, lockfile, build system, test runner, or CI workflow is present. Fonts and the Supabase client are loaded from CDNs; jsPDF is pinned from jsDelivr for PDF downloads.
- **Configuration:** `public/js/config.js` contains the Supabase URL and the public anon key. The anon key is intended to be present in browser code; data protection depends on RLS. No service-role key was found in the inspected application configuration.

### Request flow

1. `public/index.html` loads the Supabase client, `config.js`, and `schedules.js`.
2. `schedules.js` checks the current Supabase Auth session. Anonymous users see the published student view. Staff sessions are matched to a `profiles` row and shown the teacher or Program Head view.
3. The JavaScript performs lookup and catalog CRUD through Supabase PostgREST. Schedule writes and period lifecycle/copy/suggestion checks use SQL RPC functions; status changes use RLS-protected table updates.
4. PostgreSQL RLS limits direct table/view access. SQL functions validate schedule rules; database constraints, the schedule trigger, and v4 period locks provide a second enforcement layer.

## Project structure and important files

| File | Responsibility |
| --- | --- |
| `index.html` | Root redirect to `public/`. |
| `public/index.html` | Student view, staff login, schedule form/table, reports, curriculum, and room/period setup interface. |
| `public/js/config.js` | Supabase project URL and public anon key. |
| `public/js/schedules.js` | Application startup, login/session handling, catalog/period CRUD, schedules, grid views, exports, reports, bulk actions, and suggestions. |
| `public/css/styles.css` | Layout, colors, form controls, tables, alerts, responsive and print styles. |
| `supabase/schema.sql` | Initial tables, relationships, constraints, RLS policies, views, helper functions, and initial `create_schedule` RPC. |
| `supabase/migration_v2.sql` | Online-class support, fixed breaks, teacher load limit, schedule validation/RPC updates, and the student view update. |
| `supabase/migration_v3.sql` | Faculty availability, curriculum assignments, schedule-pair support, v3 validation and triggers. |
| `supabase/migration_v4.sql` | Period dates/lifecycle, atomic schedule copying, and conflict suggestions. |
| `supabase/migration_v5.sql` | Allows classes to span a configured break. |
| `supabase/migration_v6.sql` | Allows different programs to share an exact subject, teacher, room, day, and time. Extended by v9. |
| `supabase/migration_v9.sql` | Treats rows with the same teacher, room, day, start and end time in the active period as one combined class; combined courses are not conflicts and count once toward load. |
| `supabase/migration_v10.sql` | Creates the 2025-2026 1st and 2nd Semester periods and makes 1st Semester active, keeping earlier periods and their schedules. |
| `supabase/seed.sql` | Sample active period, programs, years, courses, teachers, and rooms. |
| `supabase/users.sql` | Creates profile-role links for Auth users matched by email. |
| `README.md` | Feature and setup summary, including migration order and deployment notes. |
| `TESTING.md` | Manual browser, role, SQL-read-only, and Postman checklist. It explicitly says there is no automated test suite. |

## Database model and relationships

The SQL source defines these tables and relationships:

- `scheduling_periods`: academic year, semester (`1st`, `2nd`, `Summer`), active flag, and optional v4 start/end dates. Unique by year+semester; a partial unique index permits at most one active period.
- `programs`, `year_levels`: lookup tables with unique names.
- `subjects`: unique course code, name, positive smallint units, and free-text prerequisite.
- `teachers`: name, optional email, legacy free-text `availability`; v2 adds `max_load_hours` (default 24).
- `rooms`: unique room name and physical availability; v2 adds `is_online`.
- `profiles`: one row per `auth.users` account, role constrained to `admin` or `teacher`, optional link to a teacher.
- `schedules`: foreign keys to period, subject, program, year, teacher, and room; day/time/status fields. v2 adds `is_online`; v3 adds nullable `schedule_pair_id`.
- `break_periods` (v2): labeled time windows; seed behavior inserts a lunch break from noon to 1 PM only when the table is empty.
- `teacher_availability` (v3): one row per teacher/day, with start and end times. The primary key limits the model to one window per faculty member per day.
- `curriculum_courses` (v3): subject/program/year/semester mapping, unique for each combination.

`supabase/schema.sql` adds foreign keys and checks, including valid days/status, positive course units, end after start, and GiST exclusion constraints preventing overlapping room, teacher, and program/year schedules in one period. v2 changes the room exclusion constraint so concurrent online schedules may share the virtual room. v3 adds a shared validator and a transaction advisory lock for schedule writes. v4 serializes active-period transitions, validates periods before activation, and copies source schedules as drafts in one transaction.

The v3 migration seeds Monday-Saturday 08:00-17:00 availability for existing teachers and adds an insert trigger to seed the same defaults for future teachers. It backfills curriculum mappings from schedules in the active period. Those inserts use conflict-ignore behavior; existing schedule rows are not rewritten by the backfill.

## SQL functions, triggers, and security

### Core functions and triggers

- `is_admin()` and `my_teacher_id()` in `schema.sql` are `SECURITY DEFINER` SQL helpers with `search_path = public`; they read the caller's profile.
- `create_schedule()` is defined in the base schema and replaced by v2. v3 replaces `schedule_problems()` with a compatibility wrapper over `schedule_problems_all()` but does **not** replace `create_schedule()`.
- `schedule_problems()` / `schedule_problems_all()` check room, teacher, cohort, breaks, teacher load, class start/duration, and faculty availability.
- `enforce_schedule_rules()` is a before-write trigger on active-period schedule inserts and updates to schedule fields. It serializes schedule writes with `pg_advisory_xact_lock` and rechecks rules. Status-only changes are intentionally outside this trigger, preserving legacy rows during publish/unpublish.
- `create_schedule_pair()` and `update_schedule_pair()` accept only Mon/Wed or Tue/Thu pairs and create/update two schedule rows at the same time. v3 also replaces single-row `update_schedule()` so it cannot edit only one member of a pair.
- `schedule_pair_status_sync` mirrors a row's publish/unpublish status to its partner. `schedule_pair_delete_sync` deletes the other member when a draft pair member is deleted.
- v2's `schedule_online_sync` copies the selected room's online flag into new/edited schedules. `room_online_sync` propagates a room mode change to its schedules.
- `teacher_availability_seed` creates default availability for new teachers.

### RLS model in source

- `programs`, `year_levels`, and `scheduling_periods` have public read policies for picker/period data.
- Base lookup tables and the new availability/curriculum tables have admin-only policies using `is_admin()`.
- `profiles` allows a user to read their own profile and the Program Head to manage profiles.
- `schedules` permits admin reads/inserts/updates; delete policy permits only drafts.
- `student_schedule` exposes only published active-period schedule fields to anonymous/authenticated users.
- `teacher_schedule` exposes published active-period rows filtered to `my_teacher_id()` and is not granted to `anon`.
- RPC functions revoke execution from `public`/`anon` and grant it to `authenticated`; the scheduling RPCs also check `is_admin()`.

The views are ordinary PostgreSQL views, which run with owner privileges by default. Their selected columns and row filters are therefore an important security boundary. Source definitions are narrow and do not include teacher email or drafts in the student view.

## Feature status from current source

Statuses below describe source implementation, not live end-to-end verification.

| Feature | Status | Evidence and limit |
| --- | --- | --- |
| Anonymous student schedule by program/year | Implemented | `student_schedule` view and student picker in `public/js/schedules.js`; only published active-period rows are shown. |
| Subject search for students | Implemented | Client query filters `subject_code`/`subject_name` with `ilike` and a debounce. It searches the public view. |
| Staff login and profile roles | Implemented | Supabase password login and `profiles` lookup; unknown/no-profile users are signed out. |
| Program Head schedule create/edit/publish/unpublish/delete draft | Implemented | Form and table handlers plus SQL RPCs and RLS. Published rows cannot be deleted through the policy. |
| Room/teacher/cohort overlap checks | Implemented | Exclusion constraints plus helper checks; online rooms are handled specially in v2/v3. |
| 2.5-hour duration, earliest 8:00 AM, break and 30-minute gaps | Implemented in source | Form computes end time and v3 validator checks it server-side. Real database installation and edge-case behavior were not independently exercised in this review. |
| Faculty availability enforcement | Implemented in source; management partial | SQL checks the complete class window. Defaults are seeded for Mon-Sat 08:00-17:00. The app reports availability but does not edit windows; a Program Head must use Supabase Table Editor. The model supports one window per day. |
| Partner-day schedules | Implemented through RPCs/UI | Two rows represent one course meeting on Mon/Wed or Tue/Thu. UI and triggers synchronize edits/status/deletion. Database does not enforce the full pair shape on arbitrary direct writes. |
| Catalog and curriculum management | Implemented in UI/RLS | Program Head can add/edit/remove subjects, programs, teachers, and curriculum assignments. Schedule options still filter to active-semester mappings; schedule RPC membership enforcement remains a separate integrity gap. |
| Faculty schedule and all-faculty summary | Implemented | Reports show schedule rows, load and availability for an individual faculty member or all faculty. |
| Room schedule/availability and print reports | Implemented | Client-side reports use loaded active-period schedules; physical-room free time is shown in a fixed 07:00-20:00 range. |
| Room CRUD and period management | Implemented in UI/RLS + v4 RPCs | Program Heads add/edit/remove rooms and periods, start/close periods, and copy schedules. Period copy rolls back if any copied schedule fails validation. |
| Student/teacher weekly timetable | Implemented | Mon-Sat, 30-minute rows in a horizontally scrollable grid; the flat list remains available. |
| Schedule/report exports | Implemented | CSV, jsPDF PDF downloads, and ICS recurring events bounded by period dates. Existing periods require their dates to be entered before ICS export. |
| Bulk publish/unpublish | Implemented | Program Head selection updates are RLS-protected; paired status triggers synchronize partner rows. |
| Conflict suggestions | Implemented in v4 RPC | Returns available rooms at the selected time and valid start times in the selected room, using shared schedule rules. |
| Automatic schedule generation | Missing by design | README says this system assists manual scheduling and does not generate a timetable. |
| Student accounts/permissions | Missing by design | Students are anonymous and can only read the published view. |
| In-app faculty availability editor | Missing | The workflow still uses the Supabase Table Editor. |
| Automated test suite/CI | Missing | No package/test runner or CI workflow is present; `TESTING.md` is a manual test plan. |

## Recent updates reviewed

The latest feature branch history is:

- `f9bebba` — `Sync schedules when room mode changes` (v2 trigger update).
- `8ee1d05` — adds the v3 migration, curriculum/faculty/report UI, partner days, and related docs.
- `2b5ce6e` — displays Supabase save errors and recalculates class end time on submit.
- `efb3a27` — translates v3 validation messages to user-facing conflict explanations.

The client-side conflict translator handles the current SQL message families (duration, availability, room occupancy, teacher/cohort gaps, breaks, max load, and missing active period). The v4 changes are not yet applied to the connected Supabase project; run migrations in order on a disposable test project and complete the updated TESTING.md checks before release.

The SQL text in `migration_v3.sql` contains a replacement character between the occupied-room time endpoints (`%s�%s`, around line 117). The frontend formatter currently tolerates a non-alphanumeric separator, but the database message itself can display a damaged separator in other clients.

## Findings and recommended improvements (priority order)

### 1. High — enforce curriculum membership at the database boundary

The browser filters the course dropdown by program, year, and active semester, but the schedule table has no curriculum foreign key/check, and the scheduling RPC signatures do not include or validate the active curriculum mapping. A direct authenticated Program Head RPC call can therefore schedule a valid `subjects.id` under a program/year where the course is not assigned. RLS still restricts this to an admin, so this is a data-integrity gap rather than a public access path.

**Recommendation:** Add the minimal active-period curriculum check to the shared database schedule validator/RPC path, covering create, edit, and pair operations. Keep the front-end filter as a usability aid.

### 2. High — protect paired-row invariants against direct admin writes

`create_schedule_pair()` creates valid pairs and the UI edits both rows, but `schedule_pair_id` has no constraint or trigger guaranteeing exactly two matching rows, valid partner days, same period/course/teacher/room/time, or consistent status. Admins have direct schedule update access; editing that column or one row directly can leave an orphan/inconsistent pair. The status/delete triggers assume pair IDs are valid.

**Recommendation:** Add the smallest database guard for pair membership/consistency or restrict direct writes to the paired RPC path. Keep existing paired operations intact.

### 3. High — make database release history reproducible

`migration_v2.sql` and `migration_v3.sql` are standalone root-level scripts rather than timestamped entries under Supabase's standard migration directory. v3 creates tables/policies/sequence and adds a column without idempotent guards, so it is a one-time script and will fail if replayed. Manual SQL Editor application also is not represented in a checked-in migration-history mechanism. `schema.sql` does not enable `btree_gist`; a new database depends on enabling it separately before its exclusion constraints can be created.

**Recommendation:** Document and follow a single ordered path (`schema.sql` plus required extension, then v2, then v3, seed/users as appropriate), and move future SQL changes into a tracked migration workflow. Do not blindly rerun an applied script.

### 4. Medium — surface lookup and schedule-load errors

`loadLookups()` uses `Promise.all` and replaces failed query data with empty arrays without showing which request failed. `loadSchedules()` clears the table when fetching fails but does not show an error; `loadPeriodLabel()` also ignores its query error. Missing v3 objects, RLS/grant mistakes, network failure, and a truly empty list can look alike to staff.

**Recommendation:** Preserve current layout but show a concise alert for failed required lookups/schedule loads and log technical details to the console. Distinguish an empty result from a failed request.

### 5. Medium — normalize a create-race validation response

v3's schedule trigger can raise a check violation after the RPC's precheck if a concurrent write wins. v2's `create_schedule()` catches `check_violation` and returns `Invalid day or time`, which is inaccurate for a duration, availability, break, gap, or race conflict. Pair and update RPCs return the SQL message instead.

**Recommendation:** Make the single-create RPC return the trigger's validation reason or a clear conflict response for this race path.

### 6. Medium — strengthen test coverage around SQL/UI contracts

The project has a useful manual checklist but no automated tests. Important contracts include RPC argument names/signatures, error-message translation, legacy rows, pair synchronization, RLS roles, and direct-write constraints. The live Supabase configuration and database were not available for this review.

**Recommendation:** Start with a small repeatable test for the pure conflict-message formatter and schedule-time calculation, then add database integration tests in a disposable Supabase project for RPC/RLS/pair invariants. Keep manual production checks read-only.

### 7. Low — reduce future frontend and lookup scaling friction

`public/js/schedules.js` handles session state, data access, DOM rendering, scheduling, reports, and curriculum in one 795-line file. Admin reports load all active schedules and filter client-side; student contains-subject searches use leading-wildcard `ILIKE`. This is reasonable for the current small static application but can become harder to change and slower as course/schedule volume grows. The availability table's one-window-per-day key is also a deliberate limitation.

**Recommendation:** Avoid splitting or adding infrastructure preemptively. Revisit pagination/indexing and file separation only when schedule volume or feature changes make the current page difficult to maintain. Add multiple daily availability windows only if a real requirement appears.

## Verification limits and readiness

- The provided Supabase screenshots showed the v2 marker checks as present and later showed these four v3 checks as `true`: `teacher_availability`, `curriculum_courses`, `schedules.schedule_pair_id`, and `schedule_rules_guard`. These screenshots verify those named objects at that time; they do not prove every v3 function, trigger, policy, backfill row, or RLS behavior is correct.
- No live Supabase connection was used during this review. Table contents, deployed function definitions, grants, trigger definitions, RLS policies, migration history, and production backups were not independently queried.
- No SQL was executed and no migration was applied. No application code or database structures were modified.
- No browser end-to-end suite or automated tests were run. Current source and manual test documentation were reviewed.

**Readiness:** The architecture is simple and consistent, and the current source contains the requested scheduling/curriculum/report capabilities. It is ready for small, carefully scoped feature work after the v3 database release is confirmed in the intended project and the manual role/conflict test plan is run. Database-level curriculum and pair invariants, database migration tracking, and test coverage are the main areas to address before treating the system as strongly production-hardened.
