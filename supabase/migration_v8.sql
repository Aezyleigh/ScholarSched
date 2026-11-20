-- ScholarSched v8: read-only access for teachers and richer teacher schedule rows.
-- Requires migrations v2 through v7. Run this whole file once in the Supabase SQL editor.

begin;

-- ---------- Teachers can read the data they are allowed to view ----------
-- Writes stay Program Head only: these policies add SELECT access on top of the
-- existing admin_all policies, so a teacher can browse but never change records.
drop policy if exists teacher_read on public.subjects;
create policy teacher_read on public.subjects for select to authenticated using (true);

drop policy if exists teacher_read on public.teachers;
create policy teacher_read on public.teachers for select to authenticated using (true);

drop policy if exists teacher_read on public.rooms;
create policy teacher_read on public.rooms for select to authenticated using (true);

drop policy if exists teacher_read on public.teacher_availability;
create policy teacher_read on public.teacher_availability for select to authenticated using (true);

drop policy if exists teacher_read on public.curriculum_courses;
create policy teacher_read on public.curriculum_courses for select to authenticated using (true);

drop policy if exists teacher_read on public.departments;
create policy teacher_read on public.departments for select to authenticated using (true);

drop policy if exists teacher_read on public.curriculum_years;
create policy teacher_read on public.curriculum_years for select to authenticated using (true);

-- ---------- Teacher schedule rows carry ids for the report screens ----------
-- New columns must be appended, so create or replace stays valid.
create or replace view public.teacher_schedule as
select s.id, s.day, s.start_time, s.end_time, s.status,
       sub.subject_code, sub.subject_name, sub.units,
       pr.program_name, y.year_level, t.teacher_name, r.room_name,
       p.semester, p.academic_year,
       s.program_id, s.year_level_id, s.teacher_id, s.room_id
from public.schedules s
join public.scheduling_periods p on p.id = s.period_id and p.is_active
join public.subjects sub   on sub.id = s.subject_id
join public.programs pr    on pr.id = s.program_id
join public.year_levels y  on y.id = s.year_level_id
join public.teachers t     on t.id = s.teacher_id
join public.rooms r        on r.id = s.room_id
where s.status = 'PUBLISHED' and s.teacher_id = public.my_teacher_id();

revoke all   on public.teacher_schedule from anon;
grant select on public.teacher_schedule to authenticated;

commit;
