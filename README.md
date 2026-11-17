# ScholarSched

A web-based scheduling system for the College Department of Unida Christian Colleges.
It helps the Program Head create class schedules, detect conflicts, publish finalized
schedules, and lets teachers and students view them.

ScholarSched assists the person who builds the schedule. It does not generate the
timetable automatically.

## Features

- **Scheduling rules.** New or edited classes start no earlier than 8:00 AM, last exactly
  2 hours 30 minutes, fit within faculty availability, and keep the configured lunch break.
  Faculty and the same Program + Year Level need at least 30 minutes between classes.
  Physical room conflicts and other overlapping classes are blocked.
- **Draft and publish workflow.** New schedules are saved as private drafts. The Program Head
  publishes them, can unpublish them, and can delete drafts.
- **Student view without login.** Students choose their Program and Year Level and see only
  published schedules.
- **Teacher view.** Teachers log in and see their own published teaching schedule.
- **Partner days.** Monday/Wednesday and Tuesday/Thursday can be scheduled together at
  the same time; Friday and Saturday remain individual choices.
- **Curriculum management.** The Program Head can edit course details and each
  program/year/semester course assignment. Schedule courses come from the active curriculum.
- **Faculty reports.** Individual availability and a summary of all faculty, class counts,
  weekly load, and availability are available in Reports.
- **Scheduling period.** New schedules belong to the active Academic Year and Semester.
  Existing schedules are preserved by the v3 migration and checked when edited.

## Roles

| Role | Account | Can do |
| --- | --- | --- |
| Program Head | Yes | Create, publish, unpublish, and delete draft schedules |
| Teacher | Yes | View own published schedule |
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
    ├── seed.sql          Sample period, programs, subjects, teachers, rooms
    └── users.sql         Links staff logins to roles (run after creating the users)
```


`supabase/migration_v3.sql` adds the new scheduling rules, faculty availability, partner-day
support, and curriculum tables. Apply it after v2 when deploying these features.

## Security notes

- The anon key is public by design. Data is protected by **Row Level Security** policies in
  `supabase/schema.sql`. Do not loosen them without testing (see [TESTING.md](TESTING.md)).
- Students read only the `student_schedule` view: published schedules for the active period,
  with no drafts and no teacher emails.
- Teachers read only their own published schedules through the `teacher_schedule` view.
- Only the Program Head can create, update, or delete schedules, and only drafts can be deleted.
- Use real passwords for real accounts and delete the sample accounts before real use.

## Limitations

- Faculty availability can be reviewed in Reports; administrators manage its day/time windows
  in Supabase Table Editor. The migration seeds Monday-Saturday, 8:00 AM-5:00 PM windows.
- Programs, year levels, rooms, and scheduling periods remain managed in Supabase Table Editor.
- An internet connection is required.


