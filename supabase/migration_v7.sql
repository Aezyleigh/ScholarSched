-- ScholarSched v7: departments, room details, curriculum versions, semester-aware
-- public views and backup support.
-- Requires migrations v2 through v6. Run this whole file once in the Supabase SQL editor.

begin;

-- ---------- Faculty departments ----------
create table if not exists public.departments (
  id              bigint generated always as identity primary key,
  department_name text not null unique
);

alter table public.departments enable row level security;
drop policy if exists admin_all on public.departments;
create policy admin_all on public.departments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.departments to authenticated;
grant usage, select on sequence public.departments_id_seq to authenticated;

alter table public.teachers
  add column if not exists department_id bigint references public.departments(id) on delete set null;

-- ---------- Room capacity and type ----------
alter table public.rooms add column if not exists capacity integer;
alter table public.rooms add column if not exists room_type text not null default 'Regular Room';

-- ---------- Curriculum versions ----------
create table if not exists public.curriculum_years (
  valid_years text primary key
);

alter table public.curriculum_years enable row level security;
drop policy if exists admin_all on public.curriculum_years;
create policy admin_all on public.curriculum_years for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.curriculum_years to authenticated;

alter table public.curriculum_courses add column if not exists valid_years text;

-- One course may appear once per curriculum version.
alter table public.curriculum_courses
  drop constraint if exists curriculum_courses_subject_id_program_id_year_level_id_semester_key;
alter table public.curriculum_courses
  drop constraint if exists curriculum_courses_unique;
alter table public.curriculum_courses
  add constraint curriculum_courses_unique
  unique (subject_id, program_id, year_level_id, semester, valid_years);

alter table public.curriculum_courses
  drop constraint if exists curriculum_courses_year_fk;
alter table public.curriculum_courses
  add constraint curriculum_courses_year_fk foreign key (valid_years)
  references public.curriculum_years(valid_years) on update cascade;

-- Keep the versions that existing curriculum rows already use.
insert into public.curriculum_years (valid_years)
select distinct valid_years from public.curriculum_courses where valid_years is not null
on conflict (valid_years) do nothing;

-- ---------- Semester-aware public views ----------
-- Students may switch between semesters, so the published view exposes both the
-- semester and the academic year instead of only the active period.
-- A view cannot change its column list with create or replace, and the earlier
-- v2 view already exposed program_name and year_level, so both views are dropped
-- and recreated with one stable list of columns.
drop view if exists public.student_schedule;
create view public.student_schedule as
select s.id, s.program_id, s.year_level_id, s.day, s.start_time, s.end_time,
       sub.subject_code, sub.subject_name, sub.units,
       t.teacher_name, r.room_name, pr.program_name, y.year_level,
       p.semester, p.academic_year,
       s.teacher_id, s.room_id
from public.schedules s
join public.scheduling_periods p on p.id = s.period_id
join public.subjects sub  on sub.id = s.subject_id
join public.teachers t    on t.id = s.teacher_id
join public.rooms r       on r.id = s.room_id
join public.programs pr   on pr.id = s.program_id
join public.year_levels y on y.id = s.year_level_id
where s.status = 'PUBLISHED';

drop view if exists public.teacher_schedule;
create view public.teacher_schedule as
select s.id, s.day, s.start_time, s.end_time, s.status,
       sub.subject_code, sub.subject_name, sub.units,
       pr.program_name, y.year_level, t.teacher_name, r.room_name,
       p.semester, p.academic_year
from public.schedules s
join public.scheduling_periods p on p.id = s.period_id and p.is_active
join public.subjects sub   on sub.id = s.subject_id
join public.programs pr    on pr.id = s.program_id
join public.year_levels y  on y.id = s.year_level_id
join public.teachers t     on t.id = s.teacher_id
join public.rooms r        on r.id = s.room_id
where s.status = 'PUBLISHED' and s.teacher_id = public.my_teacher_id();

grant select on public.student_schedule to anon, authenticated;
revoke all   on public.teacher_schedule from anon;
grant select on public.teacher_schedule to authenticated;

-- ---------- Backup support ----------
-- Restoring rows with their original ids leaves identity sequences behind.
-- The Program Head can call this after a restore so new rows do not collide.
create or replace function public.sync_identity_sequences() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_table text;
  v_max   bigint;
  v_seq   text;
begin
  if not public.is_admin() then
    raise exception 'You do not have permission to do this';
  end if;
  foreach v_table in array array[
    'departments', 'programs', 'year_levels', 'subjects', 'teachers', 'rooms',
    'curriculum_courses', 'scheduling_periods', 'schedules'
  ] loop
    execute format('select coalesce(max(id), 0) from public.%I', v_table) into v_max;
    v_seq := pg_get_serial_sequence('public.' || v_table, 'id');
    if v_seq is not null then
      perform setval(v_seq, greatest(v_max, 1), v_max > 0);
    end if;
  end loop;
end;
$$;
revoke all on function public.sync_identity_sequences() from public, anon;
grant execute on function public.sync_identity_sequences() to authenticated;

commit;
