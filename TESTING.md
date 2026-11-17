# Testing ScholarSched

ScholarSched has no automated test suite, so use the browser and read-only Supabase checks.
Apply `migration_v4.sql` after v2 and v3 in a disposable test project first. Do not run write tests
or copy periods in production while verifying these features. The migration is a one-time database
change; inspect existing duplicate periods before applying it.

| Check | What it proves | Tool |
| --- | --- | --- |
| Setup | Database, users, and config are in place | Supabase dashboard |
| Functional | The app behaves as the workflow describes | Browser |
| Security | Each role can only do what it should | Browser console |
| API | RPC access and returned errors match role/rules | Postman |

Record every result in the test log at the end. It is good evidence for your project.

## 1. Setup check

In the Supabase dashboard:

1. **Table Editor** shows these tables with rows: `scheduling_periods` (1, with `is_active`
   true), `programs` (2), `year_levels` (4), `subjects` (3), `teachers` (2), `rooms` (3),
   `profiles` (3). `schedules` is empty.
2. **Authentication > Users** lists the three staff users.
3. **Database > Extensions** shows `btree_gist` enabled. Without it `schema.sql` fails.
4. `public/js/config.js` has your real project URL and anon key, not the placeholders.
5. Open the app through Live Server or `python -m http.server`. The student page shows the
   Program and Year level dropdowns filled in. Empty dropdowns mean the config or the seed
   data is wrong. Press **F12** and read the Console for the error.

## 2. Functional tests (browser)

Use a private/incognito window for the student tests so no staff session interferes.

### 2.1 Student page (no login)

| # | Test | Expected |
| --- | --- | --- |
| S1 | Open the site | Student page with Program and Year level pickers |
| S2 | Pick nothing | "Choose your program and year level." |
| S3 | Pick a group with nothing published | "No published schedule for this program and year level yet." |
| S4 | Pick a group with a published schedule | Only that group's classes appear |
| S5 | Reload the page | The last choice is remembered on this device |

### 2.2 Login

| # | Test | Expected |
| --- | --- | --- |
| L1 | Staff log in with a wrong password | "Invalid email or password" |
| L2 | Log in as the Program Head | Create form and all-schedules table, period label at the top |
| L3 | Log in as a teacher | Only "My published schedule", no create form, no action buttons |
| L4 | Log out | Returns to the student page |
| L5 | Reload while logged in | Still logged in |

### 2.3 Creating schedules and conflicts (Program Head)

First assign a course to the active semester in **Curriculum**. Create a test class: CS101,
BS Computer Science, 3rd Year, Juan Dela Cruz, Room 201, Monday starting at 8:00 AM. Its
end time should fill automatically as 10:30 AM.

| # | Test | Expected |
| --- | --- | --- |
| C1 | Save the schedule above | "Saved as draft." It appears with status DRAFT |
| C2 | Same room, teacher, or cohort overlaps Monday; try 8:30 AM | Rejected with a relevant conflict |
| C3 | Change start to 10:00 AM | Rejected because the 2.5-hour class overlaps the fixed lunch break |
| C4 | Try to start before 8:00 AM | Browser blocks it; the database also rejects it |
| C5 | Use a course not assigned to the selected program/year/active semester | Course is not selectable |
| C6 | Select a different day at 8:00 AM | Saved if its room, teacher, and cohort are free |
| C7 | Verify the end-time field | Read-only and exactly 2 hours 30 minutes after start |
| C8 | Assign an unavailable day/time through a direct schedule RPC | Rejected with faculty availability message |

### 2.4 Draft and publish workflow

| # | Test | Expected |
| --- | --- | --- |
| P1 | Publish a draft | Status becomes PUBLISHED, buttons change to Unpublish |
| P2 | No Delete button on a published row | Confirmed |
| P3 | Unpublish | Returns to DRAFT |
| P4 | Delete a draft | Confirmation prompt, then removed |

### 2.5 Visibility

Create and publish two schedules: one for Juan with BS Computer Science 3rd Year, one for
Maria with BS Information Technology 2nd Year.

| # | Test | Expected |
| --- | --- | --- |
| V1 | Log in as Juan | Sees only his schedule |
| V2 | Log in as Maria | Sees only hers |
| V3 | Student picks BS Computer Science, 3rd Year | Sees only the first schedule |
| V4 | Student picks BS Information Technology, 2nd Year | Sees only the second |
| V5 | Program Head unpublishes the first, then teacher and student refresh | It disappears for both |
| V6 | Create a draft and never publish it | Never appears for any teacher or student |

### 2.6 Partner days, curriculum, and faculty reports

| # | Test | Expected |
| --- | --- | --- |
| F1 | Create a Monday/Wednesday paired class | Two schedule rows, same class details and time |
| F2 | Edit the paired class | Both days update together |
| F3 | Publish or unpublish one paired row | Both paired days change status together |
| F4 | Delete a paired draft | Confirmation says both days; both draft rows are removed |
| F5 | Try to change a paired class to a single day | Rejected; paired schedules stay paired |
| F6 | Open Curriculum and edit a course | Course code/name/units/prerequisite update; duplicates show an error |
| F7 | Edit a curriculum entry's course, program, year, or semester | Entry updates; duplicate assignments are rejected |
| F8 | Add/remove a curriculum assignment | Schedule course options reflect the assignment; existing schedules remain |
| F9 | Open the all-faculty report | Each faculty member shows classes, weekly load/limit, and Mon-Sat availability |
| F10 | Edit a faculty availability row in Supabase, then create outside its window | Schedule is rejected |



### 2.7 Rooms, periods, timetable, exports, bulk actions, and suggestions (migration v4)

Run these checks in a disposable Supabase project with migration v4 applied. Do not perform the
write/copy checks against production.

| ID | Test | Expected |
| --- | --- | --- |
| R1 | Program Head adds, edits, and removes an unused room | Room appears in the schedule picker; duplicate names are rejected; referenced rooms cannot be deleted |
| PER1 | Start a period with an invalid academic year or date range | The app rejects the input and does not change the active period |
| PER2 | Start a duplicate year/semester | The app reports the duplicate; only one period remains |
| PER3 | Close the active period, then start another | There is briefly no active period after close; new period becomes active when started |
| PER4 | Copy a valid prior period | All copied rows are drafts; paired days remain paired; student/teacher views only show published rows |
| PER5 | Copy a period containing a conflict or invalid assignment | Copy fails atomically; no new period or partial copied schedules remain and the old active period stays active |
| PER6 | Activate an existing period with invalid schedules | Activation fails and the previous active period remains active |
| T1 | View student and teacher schedules as a weekly timetable on desktop and a narrow phone viewport | Mon-Sat and time labels are readable; horizontal scrolling stays within the grid; only that user's published rows appear |
| E1 | Export student, teacher, and Program Head schedules as CSV | Download contains only the current selection/active period; cells are quoted and formula-leading values are neutralized |
| E2 | Export a report as CSV/PDF | Export columns and rows match the currently displayed report |
| E3 | Download PDF | A PDF downloads with the selected schedule/report title and data |
| E4 | Export calendar with a configured period date range | Each class repeats weekly on the right weekday in Manila time and stops at the period end date |
| E5 | Export calendar before setting period dates | App explains that the active period needs start/end dates |
| B1 | Select multiple drafts and publish; select published rows and unpublish | Confirmation appears; selected statuses change; paired days stay synchronized |
| B2 | Select rows with mixed statuses and use one bulk action | Only rows eligible for that action change; no drafts are accidentally unpublished or vice versa |
| C1 | Save into a room/teacher/cohort conflict | Save is blocked and the app offers available rooms and alternative start times |
| C2 | Try suggestions outside teacher availability or across lunch/load limits | Suggestions exclude times that fail the shared schedule validator |
| ACC1 | As a teacher or anonymous student, attempt room/period writes, bulk status changes, or suggestions | RLS/RPC authorization blocks every write/action |

## 3. Security tests (browser console)

The safety of this system depends on Row Level Security, so test it directly. These
commands call Supabase exactly as the page does. Open the site, press **F12**, choose the
**Console** tab, and paste each line. `sb` is the Supabase client defined in `schedules.js`.

A blocked read returns an **empty list**, not an error. That is correct.

### 3.1 As an anonymous student (not logged in)

```js
(await sb.from('schedules').select()).data          // expect []  (no drafts, no raw table)
(await sb.from('teachers').select()).data           // expect []  (no teacher emails)
(await sb.from('profiles').select()).data           // expect []
(await sb.from('student_schedule').select()).data   // expect published classes only
(await sb.from('schedules').insert({status:'DRAFT'})).error   // expect an error
(await sb.rpc('create_schedule', {p_subject_id:1,p_program_id:1,p_year_level_id:1,
  p_teacher_id:1,p_room_id:1,p_day:'Monday',p_start:'08:00',p_end:'10:30'})).error  // expect a permission error
```

### 3.2 As a teacher (log in as Juan first)

```js
(await sb.from('teacher_schedule').select()).data   // expect only Juan's published classes
(await sb.from('schedules').select()).data          // expect []
(await sb.from('schedules').update({status:'PUBLISHED'}).eq('id',1).select()).data  // expect []
(await sb.from('schedules').delete().eq('id',1).select()).data                      // expect []
(await sb.rpc('create_schedule', {p_subject_id:1,p_program_id:1,p_year_level_id:1,
  p_teacher_id:1,p_room_id:1,p_day:'Tuesday',p_start:'08:00',p_end:'10:30'})).data
  // expect { ok: false, error: "You do not have permission to do this" }
```

### 3.3 As the Program Head

```js
// Deleting a PUBLISHED schedule must delete nothing (replace 1 with a published id)
(await sb.from('schedules').delete().eq('id',1).eq('status','PUBLISHED').select()).data  // expect []
```

If any anonymous or teacher test returns data it should not, **stop and fix the policy in
`schema.sql` before going further.** That is a real data leak.

## 4. API and database tests

### 4.1 Read-only database checks (SQL Editor)

Do not use INSERT, UPDATE, or DELETE against the production database for verification. The
v3 migration adds a trigger for direct writes; perform write tests only in a test project and
roll back the test transaction. These read-only queries check the seeded configuration:

```sql
select count(*) as faculty_day_windows
from public.teacher_availability;
-- Expect 6 rows for each faculty member (Monday-Saturday).

select label, start_time, end_time from public.break_periods order by start_time;
-- Expect the existing Lunch break from 12:00 to 13:00.

select count(*) as active_curriculum_assignments
from public.curriculum_courses c
join public.scheduling_periods p on p.semester = c.semester and p.is_active;
```

The first schedule rule tests should be done through the app's create form. The database
trigger is a backstop for RPC and direct writes; do not test it by leaving temporary rows in
a live project.

### 4.2 REST API tests (Postman)

Supabase exposes your tables and functions over HTTP, so Postman can test the backend
directly. Create a Postman **environment** with these variables:

| Variable | Value |
| --- | --- |
| `base` | `https://YOUR-PROJECT-REF.supabase.co` |
| `anon` | your anon key |
| `token` | filled in by the login request below |

Postman environments are ignored by `.gitignore`, so your keys and passwords stay private.

**Request 1: Log in as the Program Head** (`POST {{base}}/auth/v1/token?grant_type=password`)

- Header: `apikey: {{anon}}`
- Body (raw JSON): `{ "email": "head@example.com", "password": "YOUR-PASSWORD" }`
- Tests tab:
  ```js
  pm.test("Logged in", () => pm.response.to.have.status(200));
  pm.environment.set("token", pm.response.json().access_token);
  ```

For the next requests, add the headers `apikey: {{anon}}` and
`Authorization: Bearer {{token}}`.

| # | Request | Expected |
| --- | --- | --- |
| A1 | `GET {{base}}/rest/v1/schedules?select=*` | 200, list of schedules |
| A2 | `POST {{base}}/rest/v1/rpc/create_schedule` with the body below | 200 and `ok: true` |
| A3 | Repeat A2 with the same body | 200 and `ok: false` with a `conflicts` list |
| A4 | `PATCH {{base}}/rest/v1/schedules?id=eq.1` with `{ "status": "PUBLISHED" }` and header `Prefer: return=representation` | 200, status PUBLISHED |
| A5 | `DELETE {{base}}/rest/v1/schedules?id=eq.1` (published) with `Prefer: return=representation` | 200 and `[]`, nothing deleted |
| A6 | Log in as a teacher and repeat A2 | 200 and `ok: false`, permission error |

Body for A2:

```json
{
  "p_subject_id": 1, "p_program_id": 1, "p_year_level_id": 3,
  "p_teacher_id": 1, "p_room_id": 1,
  "p_day": "Monday", "p_start": "08:00", "p_end": "10:30"
}
```

For the anonymous student checks, use the anon key as both `apikey` and
`Authorization: Bearer`:

| # | Request | Expected |
| --- | --- | --- |
| A7 | `GET {{base}}/rest/v1/student_schedule?program_id=eq.1&year_level_id=eq.3` | 200, published classes only |
| A8 | `GET {{base}}/rest/v1/schedules` | 200 and `[]` |
| A9 | `GET {{base}}/rest/v1/teachers` | 200 and `[]` |

Add checks to each request's **Tests** tab, for example:

```js
pm.test("Status is 200", () => pm.response.to.have.status(200));
pm.test("Conflict reported", () => pm.expect(pm.response.json().ok).to.eql(false));
```

Then run the collection with **Run collection**. This is an API verification run; the project
does not include a checked-in automated test suite.

## 5. Test on other devices

After deploying (for example to GitHub Pages):

1. Open the site on a phone using mobile data, not your Wi-Fi.
2. Check that the student picker works and the table scrolls sideways without breaking
   the page.
3. Log in as a teacher on the phone and check the schedule.

## Test log

Copy this table into your documentation and fill it in.

| ID | Test | Expected | Actual | Pass/Fail | Date | Tester |
| --- | --- | --- | --- | --- | --- | --- |
| C2 | Room conflict | Blocked with room message | | | | |
| C5 | 30-minute gap between same teacher/cohort | Enforced | | | | |
| P2 | Delete a published schedule | Not allowed | | | | |
| V3 | Student sees own group only | Only that group | | | | |

## Common problems

| Symptom | Likely cause |
| --- | --- |
| `schema.sql` fails with "no default operator class for gist" | `btree_gist` is missing. Add `create extension if not exists btree_gist;` at the very top and rerun |
| Dropdowns are empty | `config.js` still has placeholders, or `seed.sql` was not run |
| Login works but "no role assigned" | `users.sql` was not run, or its emails differ from the users you created |
| Program Head sees an empty table after creating schedules | No active scheduling period (`is_active` must be true for one row) |
| Console error "sb is not defined" | You are on a different page or the script failed to load. Reload and check the Console |
| Everything works for the Program Head but teachers see nothing | The schedule is still a draft, or belongs to a different teacher |
| Changes not showing | Hard refresh with Ctrl+F5 |
