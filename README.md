# ScholarSched

A web-based scheduling system for the College Department of Unida Christian Colleges.
It helps the Program Head create class schedules, detect conflicts, publish finalized
schedules, and lets teachers and students view them.

ScholarSched assists the person who builds the schedule. It does not generate the
timetable automatically.

For step-by-step instructions for students, teachers, and Program Heads, see [USER_GUIDE.md](USER_GUIDE.md).

## Features

- **Scheduling rules.** New or edited classes start no earlier than 8:00 AM, last exactly
  2 hours 30 minutes and fit within faculty availability. Classes may span an entire configured break,
  Faculty and the same Program + Year Level need at least 30 minutes between classes.
  Physical room conflicts and other overlapping classes are blocked. Two courses may share one
  meeting when the teacher, room, day, time and semester are all the same: that is a combined
  class, shown once and counted once toward the teacher's load instead of being a conflict.
- **Draft and publish workflow.** New schedules are saved as private drafts. The Program Head
  publishes them, can unpublish them, and can delete drafts.
- **Student view without login.** Students choose their Program and Year Level and see only
  published schedules.
- **Teacher view.** Teachers log in and see their own published teaching schedule, and can
  open the Curriculum, Faculty and Rooms & Periods tabs read-only. Only the Program Head
  sees the add/edit/remove controls; the database policies enforce the same rule.
- **Weekly load check.** The create form shows the selected teacher's current load against
  their maximum weekly load as soon as the teacher and days are chosen, and blocks a save
  that would go over the limit.
- **Partner days.** Monday/Wednesday and Tuesday/Thursday can be scheduled together at
  the same time; Friday and Saturday remain individual choices.
- **Curriculum management.** The Curriculum tab reads top to bottom in three steps: choose
  the curriculum (curriculum year, program, year level, semester), add courses from a
  searchable list with a View more button, then review the list. Each row has Edit, which
  turns that row into inputs for the course code, name and units, plus Remove from this
  curriculum. Curriculum years and programs sit in a collapsible setup panel at the top.
  Schedule courses come from the active curriculum.
- **Faculty reports.** Individual availability and a summary of all faculty, class counts,
  weekly load, and availability are available in Reports. Reports can be downloaded as CSV/PDF
  or exported as a calendar file.
- **Room and period management.** Program Heads manage rooms and periods in the app. Periods
  include dates, can be closed or started, and may copy validated schedules as drafts.
- **Timetable and exports.** Students and teachers can switch between a list and a Mon-Sat
  weekly timetable. Schedule exports include CSV, PDF, and recurring calendar events (.ics).
  Combined classes appear as one entry with every course code, and exports list the partner
  courses in a Combined with column.
- **Bulk publishing and conflict help.** Program Heads can publish/unpublish selected rows; failed
  saves can suggest rooms and start times that pass the active scheduling rules.

## Roles

| Role | Account | Can do |
| --- | --- | --- |
| Program Head | Yes | Manage catalogs, rooms, periods, and schedules; publish/unpublish schedules |
| Teacher | Yes | View own published schedule, reports, curriculum, faculty and rooms/periods (read-only) |
| Student | No | View published schedule for a Program + Year Level |

## Tech stack

| Layer | Technology |
| --- | --- |
| Front end | HTML, CSS, JavaScript |
| Backend and database | Supabase (PostgreSQL, Auth, Row Level Security) |
| Version control | Git / GitHub |
| Development tool | VS Code |
| Testing | Postman and manual test cases (see [TESTING.md](TESTING.md)) |
| Deployment | Any static host, such as GitHub Pages |

## Project structure

```
ScholarSched/
├── .gitignore
├── README.md
├── USER_GUIDE.md        How students, teachers, and Program Heads use the app.
├── TESTING.md
├── index.html            Redirects to public/
├── public/
│   ├── index.html        The app (student page, staff login, Program Head and teacher screens)
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── config.js     Supabase URL and anon key
│       └── schedules.js  All app logic (talks to Supabase)
└── supabase/
    ├── schema.sql        Tables, conflict constraints, security rules, views, create_schedule()
    ├── migration_v2.sql Online rooms, breaks, max load and schedule validation
    ├── migration_v3.sql Faculty availability, curriculum, paired days and validation
    ├── migration_v4.sql Period dates/lifecycle/copy and conflict suggestions
    ├── migration_v5.sql Full-break-spanning class validation
    ├── migration_v6.sql Shared meetings across programs (extended by v9)
    ├── migration_v7.sql Departments, room details, curriculum years, semester views, backup helper
    ├── migration_v8.sql Read-only teacher access and richer teacher schedule rows
    ├── migration_v9.sql Combined classes: one meeting shared by any courses
    ├── seed.sql          Sample period, programs, subjects, teachers, rooms
    └── users.sql         Links staff logins to roles (run after creating the users)
```


Apply `schema.sql`, then migrations v2, v3, v4, v5, v6, v7, v8, and v9 in order. Migration v4 adds period dates and
protected lifecycle/copy/suggestion functions. Existing periods have no dates until a Program Head
edits them; calendar export requires a complete date range. PDF download uses the pinned jsPDF
browser bundle from jsDelivr.

Migration v7 adds faculty departments, room capacity and type, curriculum versions such as
2022-2027, semester columns on the public schedule views, and a helper that resets id sequences after
a restore. Until it is run, the app hides those controls and keeps working with the older tables.

Migration v8 lets teachers read courses, faculty, availability, rooms, departments and curriculum
while keeping every write Program Head only. It also adds program, year, teacher and room ids to
the teacher schedule view so the read-only report screens work.

Migration v9 makes the combined-class rule explicit: rows with the same teacher, room, day, start
and end time in the active period are one meeting, whatever their program, year level or course.
Combined courses are not reported as room, teacher or break conflicts, and the weekly load counts
the shared meeting once. Until it is run, the app still groups and labels combined classes, but a
new combined save is validated by the older rules.

## Security notes

- The anon key is public by design. Data is protected by **Row Level Security** policies in
  `supabase/schema.sql`. Do not loosen them without testing (see [TESTING.md](TESTING.md)).
- Students read only the `student_schedule` view: published schedules only, with no drafts and no
  teacher emails. After migration v7 the view also exposes the semester and academic year, so the
  student page can switch between 1st and 2nd Semester for the active academic year.
- Teachers read only their own published schedules through the `teacher_schedule` view.
- Only the Program Head can create, update, or delete schedules, and only drafts can be deleted.
- Use real passwords for real accounts and delete the sample accounts before real use.

## Limitations

- Faculty availability is edited under Faculty (days and time windows per teacher) and reviewed in
  Reports. New teachers start with Monday-Saturday, 8:00 AM-5:00 PM windows.
- Year levels remain managed in Supabase Table Editor.
- Creating a staff account in Settings uses Supabase sign-up. If email confirmation is enabled in
  Supabase, the new user must confirm their email before they can log in; the password reset link
  from the login page depends on the project's email settings too.
- A restore writes configuration data back in full, but schedules are restored into the active
  scheduling period only. Rows from other periods are listed and skipped, because the database
  validates every schedule against the active period.
- Period copy is atomic: if a copied schedule fails validation, the period and copied rows roll back.
- RLS and protected RPCs restrict room/period management and bulk schedule changes to the Program Head.
- An internet connection is required for Supabase and the pinned PDF library.


