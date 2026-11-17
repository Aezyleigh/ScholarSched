-- ScholarSched v3: schedule rules, partner days, faculty availability, and curriculum.
-- Existing rows are preserved. Rules are checked on new or schedule-field updates;
-- status-only publication changes remain compatible with legacy schedules.

-- ---------- Faculty availability ----------
create table public.teacher_availability (
  teacher_id bigint not null references public.teachers(id) on delete cascade,
  day text not null check (day in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')),
  start_time time not null,
  end_time time not null,
  primary key (teacher_id, day),
  check (end_time > start_time)
);
alter table public.teacher_availability enable row level security;
create policy admin_all on public.teacher_availability for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.teacher_availability to authenticated;

-- The requested default window applies to all current teachers. Existing free-text
-- teachers.availability values are retained and are not used for enforcement.
insert into public.teacher_availability (teacher_id, day, start_time, end_time)
select t.id, d.day, '08:00', '17:00'
from public.teachers t
cross join (values ('Monday'),('Tuesday'),('Wednesday'),('Thursday'),('Friday'),('Saturday')) as d(day)
on conflict (teacher_id, day) do nothing;

create or replace function public.seed_teacher_availability() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.teacher_availability (teacher_id, day, start_time, end_time)
  select new.id, d.day, '08:00', '17:00'
  from (values ('Monday'),('Tuesday'),('Wednesday'),('Thursday'),('Friday'),('Saturday')) as d(day)
  on conflict (teacher_id, day) do nothing;
  return new;
end;
$$;
drop trigger if exists teacher_availability_seed on public.teachers;
create trigger teacher_availability_seed
  after insert on public.teachers
  for each row execute function public.seed_teacher_availability();

-- ---------- Course curriculum ----------
create table public.curriculum_courses (
  id bigint generated always as identity primary key,
  subject_id bigint not null references public.subjects(id),
  program_id bigint not null references public.programs(id),
  year_level_id bigint not null references public.year_levels(id),
  semester text not null check (semester in ('1st','2nd','Summer')),
  unique (subject_id, program_id, year_level_id, semester)
);
alter table public.curriculum_courses enable row level security;
create policy admin_all on public.curriculum_courses for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.curriculum_courses to authenticated;
grant usage, select on sequence public.curriculum_courses_id_seq to authenticated;

-- Preserve current active curriculum relationships already used by schedules.
insert into public.curriculum_courses (subject_id, program_id, year_level_id, semester)
select distinct s.subject_id, s.program_id, s.year_level_id, p.semester
from public.schedules s
join public.scheduling_periods p on p.id = s.period_id and p.is_active
on conflict (subject_id, program_id, year_level_id, semester) do nothing;

-- ---------- Paired-day schedule rows ----------
create sequence public.schedule_pair_id_seq;
alter table public.schedules add column schedule_pair_id bigint;
grant usage, select on sequence public.schedule_pair_id_seq to authenticated;

-- ---------- Shared validation for create, edit, and direct table writes ----------
create or replace function public.schedule_problems_all(
  p_exclude_ids bigint[], p_program_id bigint, p_year_level_id bigint,
  p_teacher_id bigint, p_room_id bigint, p_day text, p_start time, p_end time,
  p_load_count integer default 1
) returns text[]
language plpgsql security invoker set search_path = public as $$
declare
  v_period   bigint;
  v_problems text[] := '{}';
  v_row      public.schedules%rowtype;
  v_break    public.break_periods%rowtype;
  v_name     text;
  v_online   boolean;
  v_current  numeric;
  v_new      numeric;
  v_max      numeric;
begin
  select id into v_period from public.scheduling_periods where is_active limit 1;
  if v_period is null then
    return array['No active scheduling period'];
  end if;

  if p_start < time '08:00' then
    v_problems := v_problems || 'Classes cannot start before 8:00 AM.';
  end if;
  if p_end - p_start <> interval '2 hours 30 minutes' then
    v_problems := v_problems || 'Each class must be exactly 2 hours 30 minutes.';
  end if;

  if not exists (
    select 1 from public.teacher_availability a
    where a.teacher_id = p_teacher_id and a.day = p_day
      and p_start >= a.start_time and p_end <= a.end_time
  ) then
    select teacher_name into v_name from public.teachers where id = p_teacher_id;
    v_problems := v_problems || format('Faculty availability: %s is not available for the full class on %s.', v_name, p_day);
  end if;

  -- Online classes share the virtual room, matching v2's partial room constraint.
  select is_online into v_online from public.rooms where id = p_room_id;
  if not coalesce(v_online, false) then
    select * into v_row from public.schedules s
     where s.period_id = v_period and s.day = p_day and s.room_id = p_room_id
       and not (s.id = any(coalesce(array_remove(p_exclude_ids, null), '{}'::bigint[])))
       and p_start < s.end_time and p_end > s.start_time limit 1;
    if found then
      select room_name into v_name from public.rooms where id = p_room_id;
      v_problems := v_problems || format('Schedule Conflict: %s is already occupied on %s from %s–%s.',
        v_name, p_day, to_char(v_row.start_time, 'FMHH12:MI AM'), to_char(v_row.end_time, 'FMHH12:MI AM'));
    end if;
  end if;

  -- A 30-minute gap is required between consecutive classes for the same teacher.
  select * into v_row from public.schedules s
   where s.period_id = v_period and s.day = p_day and s.teacher_id = p_teacher_id
     and not (s.id = any(coalesce(array_remove(p_exclude_ids, null), '{}'::bigint[])))
     and p_start < s.end_time + interval '30 minutes'
     and p_end + interval '30 minutes' > s.start_time limit 1;
  if found then
    select teacher_name into v_name from public.teachers where id = p_teacher_id;
    v_problems := v_problems || format('Break required: %s needs at least 30 minutes between classes on %s.', v_name, p_day);
  end if;

  -- A 30-minute gap is also required for the same program and year cohort.
  select * into v_row from public.schedules s
   where s.period_id = v_period and s.day = p_day
     and s.program_id = p_program_id and s.year_level_id = p_year_level_id
     and not (s.id = any(coalesce(array_remove(p_exclude_ids, null), '{}'::bigint[])))
     and p_start < s.end_time + interval '30 minutes'
     and p_end + interval '30 minutes' > s.start_time limit 1;
  if found then
    v_problems := v_problems || format('Break required: this Program and Year Level needs at least 30 minutes between classes on %s.', p_day);
  end if;

  for v_break in
    select * from public.break_periods where p_start < end_time and p_end > start_time order by start_time
  loop
    v_problems := v_problems || format('Break Time: this class overlaps the %s (%sâ€“%s).',
      v_break.label, to_char(v_break.start_time, 'FMHH12:MI AM'), to_char(v_break.end_time, 'FMHH12:MI AM'));
  end loop;

  select coalesce(sum(extract(epoch from (s.end_time - s.start_time)) / 3600), 0) into v_current
    from public.schedules s
   where s.period_id = v_period and s.teacher_id = p_teacher_id
     and not (s.id = any(coalesce(array_remove(p_exclude_ids, null), '{}'::bigint[])));
  v_new := extract(epoch from (p_end - p_start)) / 3600;
  select teacher_name, max_load_hours into v_name, v_max from public.teachers where id = p_teacher_id;
  if v_max is not null and v_current + v_new * p_load_count > v_max then
    v_problems := v_problems || format('Max Load: %s would have %s hours per week, but the limit is %s.',
      v_name, round(v_current + v_new * p_load_count, 1), v_max);
  end if;

  return v_problems;
end;
$$;
revoke all on function public.schedule_problems_all(bigint[],bigint,bigint,bigint,bigint,text,time,time,integer) from public, anon;
grant execute on function public.schedule_problems_all(bigint[],bigint,bigint,bigint,bigint,text,time,time,integer) to authenticated;

-- Keep the existing RPC contract for single-day callers.
create or replace function public.schedule_problems(
  p_exclude_id bigint, p_program_id bigint, p_year_level_id bigint,
  p_teacher_id bigint, p_room_id bigint, p_day text, p_start time, p_end time
) returns text[]
language sql volatile security invoker set search_path = public as $$
  select public.schedule_problems_all(array[p_exclude_id], p_program_id, p_year_level_id,
    p_teacher_id, p_room_id, p_day, p_start, p_end, 1);
$$;
revoke all on function public.schedule_problems(bigint,bigint,bigint,bigint,bigint,text,time,time) from public, anon;
grant execute on function public.schedule_problems(bigint,bigint,bigint,bigint,bigint,text,time,time) to authenticated;

-- Protect direct admin table writes as well as the app RPCs. One transaction lock
-- serializes schedule writes so simultaneous saves cannot bypass the 30-minute checks.
create or replace function public.enforce_schedule_rules() returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  v_period bigint;
  v_problems text[];
begin
  select id into v_period from public.scheduling_periods where is_active limit 1;
  if new.period_id is distinct from v_period then return new; end if;
  perform pg_advisory_xact_lock(73121, 1);
  v_problems := public.schedule_problems_all(array[new.id], new.program_id, new.year_level_id,
    new.teacher_id, new.room_id, new.day, new.start_time, new.end_time, 1);
  if cardinality(v_problems) > 0 then
    raise exception '%', array_to_string(v_problems, ' ')
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists schedule_rules_guard on public.schedules;
create trigger schedule_rules_guard
  before insert or update of period_id, subject_id, program_id, year_level_id, teacher_id, room_id, day, start_time, end_time
  on public.schedules
  for each row execute function public.enforce_schedule_rules();

-- ---------- Create a paired-day class atomically ----------
create or replace function public.create_schedule_pair(
  p_subject_id bigint, p_program_id bigint, p_year_level_id bigint,
  p_teacher_id bigint, p_room_id bigint, p_day_one text, p_day_two text,
  p_start time, p_end time
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_period bigint;
  v_pair_id bigint;
  v_id_one bigint;
  v_id_two bigint;
  v_problems text[];
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if p_day_one = p_day_two then
    return jsonb_build_object('ok', false, 'error', 'Choose two different days');
  end if;
  if not ((p_day_one = 'Monday' and p_day_two = 'Wednesday') or (p_day_one = 'Wednesday' and p_day_two = 'Monday')
       or (p_day_one = 'Tuesday' and p_day_two = 'Thursday') or (p_day_one = 'Thursday' and p_day_two = 'Tuesday')) then
    return jsonb_build_object('ok', false, 'error', 'Choose Monday/Wednesday or Tuesday/Thursday');
  end if;
  select id into v_period from public.scheduling_periods where is_active limit 1;
  if v_period is null then
    return jsonb_build_object('ok', false, 'error', 'No active scheduling period');
  end if;

  v_problems := public.schedule_problems_all('{}'::bigint[], p_program_id, p_year_level_id,
    p_teacher_id, p_room_id, p_day_one, p_start, p_end, 2);
  v_problems := v_problems || public.schedule_problems_all('{}'::bigint[], p_program_id, p_year_level_id,
    p_teacher_id, p_room_id, p_day_two, p_start, p_end, 2);
  if cardinality(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Schedule Conflict', 'conflicts', to_jsonb(v_problems));
  end if;

  v_pair_id := nextval('public.schedule_pair_id_seq');
  insert into public.schedules
    (period_id, subject_id, program_id, year_level_id, teacher_id, room_id, day, start_time, end_time, status, schedule_pair_id)
  values
    (v_period, p_subject_id, p_program_id, p_year_level_id, p_teacher_id, p_room_id, p_day_one, p_start, p_end, 'DRAFT', v_pair_id)
  returning id into v_id_one;
  insert into public.schedules
    (period_id, subject_id, program_id, year_level_id, teacher_id, room_id, day, start_time, end_time, status, schedule_pair_id)
  values
    (v_period, p_subject_id, p_program_id, p_year_level_id, p_teacher_id, p_room_id, p_day_two, p_start, p_end, 'DRAFT', v_pair_id)
  returning id into v_id_two;
  return jsonb_build_object('ok', true, 'pair_id', v_pair_id, 'ids', jsonb_build_array(v_id_one, v_id_two));
exception
  when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'Schedule Conflict',
      'conflicts', jsonb_build_array('Schedule Conflict: this time was just taken. Check again.'));
  when foreign_key_violation then
    return jsonb_build_object('ok', false, 'error', 'One of the selected items does not exist');
  when check_violation then
    return jsonb_build_object('ok', false, 'error', SQLERRM);
end;
$$;
revoke all on function public.create_schedule_pair(bigint,bigint,bigint,bigint,bigint,text,text,time,time) from public, anon;
grant execute on function public.create_schedule_pair(bigint,bigint,bigint,bigint,bigint,text,text,time,time) to authenticated;

-- ---------- Update both rows in an existing pair atomically ----------
create or replace function public.update_schedule_pair(
  p_id bigint, p_subject_id bigint, p_program_id bigint, p_year_level_id bigint,
  p_teacher_id bigint, p_room_id bigint, p_day_one text, p_day_two text,
  p_start time, p_end time
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_pair_id bigint;
  v_period_id bigint;
  v_status text;
  v_ids bigint[];
  v_problems text[];
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if p_day_one = p_day_two then
    return jsonb_build_object('ok', false, 'error', 'Choose two different days');
  end if;
  if not ((p_day_one = 'Monday' and p_day_two = 'Wednesday') or (p_day_one = 'Wednesday' and p_day_two = 'Monday')
       or (p_day_one = 'Tuesday' and p_day_two = 'Thursday') or (p_day_one = 'Thursday' and p_day_two = 'Tuesday')) then
    return jsonb_build_object('ok', false, 'error', 'Choose Monday/Wednesday or Tuesday/Thursday');
  end if;
  select schedule_pair_id, period_id, status into v_pair_id, v_period_id, v_status
    from public.schedules where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Schedule not found');
  end if;
  if v_pair_id is null then
    v_ids := array[p_id];
  else
    select array_agg(id order by day) into v_ids
      from public.schedules where schedule_pair_id = v_pair_id;
    if coalesce(cardinality(v_ids), 0) <> 2 then
      return jsonb_build_object('ok', false, 'error', 'Paired schedule data is incomplete');
    end if;
  end if;

  v_problems := public.schedule_problems_all(v_ids, p_program_id, p_year_level_id,
    p_teacher_id, p_room_id, p_day_one, p_start, p_end, 2);
  v_problems := v_problems || public.schedule_problems_all(v_ids, p_program_id, p_year_level_id,
    p_teacher_id, p_room_id, p_day_two, p_start, p_end, 2);
  if cardinality(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Schedule Conflict', 'conflicts', to_jsonb(v_problems));
  end if;

  if v_pair_id is null then
    v_pair_id := nextval('public.schedule_pair_id_seq');
    update public.schedules
       set subject_id = p_subject_id, program_id = p_program_id, year_level_id = p_year_level_id,
           teacher_id = p_teacher_id, room_id = p_room_id, day = p_day_one,
           start_time = p_start, end_time = p_end, schedule_pair_id = v_pair_id
     where id = p_id;
    insert into public.schedules
      (period_id, subject_id, program_id, year_level_id, teacher_id, room_id, day, start_time, end_time, status, schedule_pair_id)
    values
      (v_period_id, p_subject_id, p_program_id, p_year_level_id, p_teacher_id, p_room_id,
       p_day_two, p_start, p_end, v_status, v_pair_id);
  else
    update public.schedules
       set subject_id = p_subject_id, program_id = p_program_id, year_level_id = p_year_level_id,
           teacher_id = p_teacher_id, room_id = p_room_id,
           day = case when id = v_ids[1] then p_day_one else p_day_two end,
           start_time = p_start, end_time = p_end
     where id = any(v_ids);
  end if;
  return jsonb_build_object('ok', true, 'pair_id', v_pair_id);
exception
  when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'Schedule Conflict',
      'conflicts', jsonb_build_array('Schedule Conflict: this time was just taken. Check again.'));
  when foreign_key_violation then
    return jsonb_build_object('ok', false, 'error', 'One of the selected items does not exist');
  when check_violation then
    return jsonb_build_object('ok', false, 'error', SQLERRM);
end;
$$;
revoke all on function public.update_schedule_pair(bigint,bigint,bigint,bigint,bigint,bigint,text,text,time,time) from public, anon;
grant execute on function public.update_schedule_pair(bigint,bigint,bigint,bigint,bigint,bigint,text,text,time,time) to authenticated;
-- Keep paired rows together when publishing, unpublishing, or deleting through the table API.
create or replace function public.sync_schedule_pair_status() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if pg_trigger_depth() = 1 and new.schedule_pair_id is not null then
    update public.schedules set status = new.status
     where schedule_pair_id = new.schedule_pair_id and id <> new.id
       and status is distinct from new.status;
  end if;
  return null;
end;
$$;
drop trigger if exists schedule_pair_status_sync on public.schedules;
create trigger schedule_pair_status_sync
  after update of status on public.schedules
  for each row
  when (new.schedule_pair_id is not null and old.status is distinct from new.status)
  execute function public.sync_schedule_pair_status();

create or replace function public.delete_schedule_pair_member() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if pg_trigger_depth() = 1 and old.schedule_pair_id is not null then
    delete from public.schedules
     where schedule_pair_id = old.schedule_pair_id and id <> old.id and status = 'DRAFT';
  end if;
  return null;
end;
$$;
drop trigger if exists schedule_pair_delete_sync on public.schedules;
create trigger schedule_pair_delete_sync
  after delete on public.schedules
  for each row
  when (old.schedule_pair_id is not null)
  execute function public.delete_schedule_pair_member();

-- The old single-row RPC must not split a paired schedule.
create or replace function public.update_schedule(
  p_id bigint, p_subject_id bigint, p_program_id bigint, p_year_level_id bigint,
  p_teacher_id bigint, p_room_id bigint, p_day text,
  p_start time, p_end time
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_problems text[];
  v_pair_id bigint;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  select schedule_pair_id into v_pair_id from public.schedules where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Schedule not found');
  end if;
  if v_pair_id is not null then
    return jsonb_build_object('ok', false, 'error', 'Use the paired schedule editor for this class');
  end if;
  if p_end <= p_start then
    return jsonb_build_object('ok', false, 'error', 'End time must be after start time');
  end if;

  v_problems := public.schedule_problems(p_id, p_program_id, p_year_level_id, p_teacher_id, p_room_id, p_day, p_start, p_end);
  if array_length(v_problems, 1) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Schedule Conflict', 'conflicts', to_jsonb(v_problems));
  end if;

  begin
    update public.schedules
       set subject_id = p_subject_id, program_id = p_program_id, year_level_id = p_year_level_id,
           teacher_id = p_teacher_id, room_id = p_room_id, day = p_day,
           start_time = p_start, end_time = p_end
     where id = p_id;
  exception
    when exclusion_violation then
      return jsonb_build_object('ok', false, 'error', 'Schedule Conflict',
        'conflicts', jsonb_build_array('Schedule Conflict: this time was just taken. Check again.'));
    when foreign_key_violation then
      return jsonb_build_object('ok', false, 'error', 'One of the selected items does not exist');
    when check_violation then
      return jsonb_build_object('ok', false, 'error', SQLERRM);
  end;

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;
revoke all on function public.update_schedule(bigint,bigint,bigint,bigint,bigint,bigint,text,time,time) from public, anon;
grant execute on function public.update_schedule(bigint,bigint,bigint,bigint,bigint,bigint,text,time,time) to authenticated;