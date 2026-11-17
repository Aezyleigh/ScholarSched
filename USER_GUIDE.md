# ScholarSched User Guide

This guide explains how students, teachers, and Program Heads use ScholarSched. You only need a web browser and an internet connection.

## Choose your role

- **Student:** View published classes without signing in.
- **Teacher:** Sign in to view your own published classes.
- **Program Head:** Sign in to manage schedules, courses, programs, teachers, rooms, periods, and reports.

## For students: view your classes

1. Open the ScholarSched website. The student schedule page opens automatically.
2. Choose your **Program** and **Year level**. The schedule for the active period appears.
3. To find a particular course, type at least two letters or numbers in **Or search any subject**. Search works across the published schedule.
4. Choose **List** to read the schedule as rows, or **Weekly timetable** to see classes by day and time.
5. On a phone, swipe the timetable sideways to see the other days.
6. To save a copy, choose **Download CSV**, **Download PDF**, or **Download calendar (.ics)**. Calendar downloads need the Program Head to set dates for the active period.

Students see published classes only. Draft schedules are not visible to students.

## For teachers: view your teaching schedule

1. Choose **Staff log in** on the student page.
2. Enter the email and password given to you by the Program Head, then choose **Log in**.
3. Your published classes appear automatically. You only see classes assigned to you.
4. Use **List** or **Weekly timetable** to change the view. On a phone, swipe the timetable sideways to view all days.
5. Use **Search schedules** to find a course, room, day, or other schedule detail.
6. Choose **Download CSV**, **Download PDF**, or **Download calendar (.ics)** to save your schedule. Calendar downloads need dates set for the active period.
7. Choose **Log out** when you are finished.

## For Program Heads: prepare the system

Do these steps before creating a new schedule.

### 1. Sign in

1. Choose **Staff log in**.
2. Enter your Program Head email and password.
3. Choose **Log in**. The Program Head tabs appear: **Schedules**, **Reports**, **Curriculum**, and **Rooms & periods**.

### 2. Add or check rooms and the active period

1. Open **Rooms & periods**.
2. Under **Rooms**, add a room name. Select **Online room** for an online class room, then choose **Add room**.
3. Use **Edit** to change a room. Use **Remove** to delete an unused room. A room used by a schedule cannot be removed until those schedules are dealt with.
4. Check the periods list and identify the active period.
5. Use **Edit** on the active period to enter its start and end dates. These dates are needed for calendar exports.

To start a new period:

1. Enter a consecutive academic year, such as `2026-2027`, and choose the semester.
2. Enter the start and end dates. The end date must be on or after the start date.
3. Leave **Copy schedules from** as **Start empty**, or select an earlier period if you want to copy its schedules as drafts.
4. Choose **Start period** and confirm if prompted. The new period becomes active and the previous period closes.
5. If copied schedules fail validation, the new period will not be created. Review the course curriculum, teacher availability, rooms, and schedule conflicts, then try again.

Closing the active period means students and teachers will not see schedules until another period is started. Check the dates and period before switching.

### 3. Set up courses, programs, teachers, and curriculum

1. Open **Curriculum**.
2. In **Course catalog**, add or edit the course code, name, units, and prerequisite. Remove a course only if it is no longer used by a schedule or curriculum entry.
3. In **Program curriculum**, choose a course, program, year level, and semester, then choose **Add to curriculum**. Use the table actions to edit or remove an assignment.
4. In **Programs**, add or edit program names. Remove a program only if it is no longer referenced by schedules or curriculum.
5. In **Teachers**, add or edit the teacher name, optional email, and maximum weekly load. Remove a teacher only after reassigning their schedules.

The schedule form only offers courses assigned to the selected program and year level for the active semester. Year levels and teacher availability windows are currently managed by the system administrator in Supabase.

## For Program Heads: create and manage schedules

1. Open **Schedules**. Confirm the active period shown at the top is the one you intend to schedule.
2. In the schedule form, choose the **Program** and **Year level** first. Then choose an available **Subject**, **Teacher**, and **Room**.
3. Choose a day. You can choose one day, or a paired pattern: Monday/Wednesday or Tuesday/Thursday.
4. Choose a **Start time**. Classes start no earlier than 8:00 AM and last exactly 2 hours 30 minutes; the end time is filled in automatically.
5. Choose **Check conflicts and save as draft**. New schedules are saved as drafts and are not shown to students or teachers.
6. If the system reports a conflict, read the message. When suggestions are available, choose a suggested room or start time and submit again.
7. Find the schedule in the table. Use **Edit** to change it. Use **Publish** when it is ready for students and teachers. Published schedules can be **Unpublished** if they need more changes.
8. To delete a draft, choose **Delete** and confirm. Published schedules must be unpublished before they can be deleted.

The system checks teacher availability and weekly load, room conflicts, and spacing between classes. The same program and year level and the same teacher need at least 30 minutes between classes. Paired days are managed together.

### Publish or unpublish several schedules

1. In the schedule table, tick the boxes beside the schedules you want to change. Use the box in the table header to select all currently visible rows.
2. Choose **Publish selected drafts** or **Unpublish selected**.
3. Review the confirmation and continue. Paired schedule days are updated together.

## For Program Heads: reports and downloads

1. Open **Reports**.
2. Choose a report type: class schedule, faculty schedule, all faculty summary, room schedule, or room availability.
3. Choose the program, year, teacher, or room filters shown for that report.
4. Use **Download report CSV**, **Download report PDF**, or **Download report calendar (.ics)**. Choose **Print report** to print it.

Reports use schedules in the active period. Check the selected report and filters before downloading. Calendar export needs start and end dates on the active period.

## Helpful tips

- **No courses in the schedule form:** Check that the active period has the right semester, then assign courses to that program, year level, and semester in **Curriculum**.
- **No schedule appears:** Students and teachers see published schedules only. Confirm the correct program/year or teacher and active period are selected.
- **A save is rejected:** Check the displayed reason. Confirm the teacher is available, the room is free, and the class does not break the 30-minute gap, 2.5-hour duration, or weekly load rules.
- **Calendar download asks for dates:** A Program Head needs to edit the active period and enter both dates.
- **A record cannot be removed:** It is still referenced by a schedule or curriculum entry. Reassign or remove the dependent entry first.
- **Login does not work:** Check the email and password with the Program Head. Staff accounts and roles must be set up before sign-in.
