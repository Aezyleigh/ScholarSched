-- ---------- 1. Online classes (no room conflict) ----------
alter table public.rooms     add column if not exists is_online boolean not null default false;
alter table public.schedules add column if not exists is_online boolean not null default false;

insert into public.rooms (room_name, availability, is_online)
values ('Online Class', 'Available', true)
on conflict (room_name) do nothing;

-- A schedule copies the is_online flag from its room automatically
create or replace function public.sync_schedule_online() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.is_online := coalesce((select is_online from public.rooms where id = new.room_id), false);
  return new;
end;
$$;

drop trigger if exists schedule_online_sync on public.schedules;
create trigger schedule_online_sync
  before insert or update of room_id on public.schedules
  for each row execute function public.sync_schedule_online();

-- The room-overlap rule now ignores online classes
alter table public.schedules drop constraint if exists no_room_overlap;
alter table public.schedules add constraint no_room_overlap exclude using gist (
  period_id with =, day with =, room_id with =,
  tsrange(date '2000-01-01' + start_time, date '2000-01-01' + end_time, '[)') with &&)
  where (not is_online);

-- ---------- 2. Break times ----------
create table if not exists public.break_periods (
  id         bigint generated always as identity primary key,
  label      text not null,
  start_time time not null,
  end_time   time not null,
  check (end_time > start_time)
);
alter table public.break_periods enable row level security;
drop policy if exists admin_all on public.break_periods;
create policy admin_all on public.break_periods for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

insert into public.break_periods (label, start_time, end_time)
select 'Lunch break', '12:00', '13:00'
where not exists (select 1 from public.break_periods);

-- ---------- 3. Maximum teaching load (hours per week) ----------
alter table public.teachers
  add column if not exists max_load_hours numeric(4,1) not null default 24 check (max_load_hours > 0);

-- ---------- 4. One shared checker used by create AND edit ----------
create or replace function public.schedule_problems(
  p_exclude_id bigint, p_program_id bigint, p_year_level_id bigint,
  p_teacher_id bigint, p_room_id bigint, p_day text, p_start time, p_end time
) returns text[]
language plpgsql stable security invoker set search_path = public as $$
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
  select is_online into v_online from public.rooms where id = p_room_id;

  -- Room (skipped for online classes)
  if not coalesce(v_online, false) then
    select * into v_row from public.schedules
     where period_id = v_period and day = p_day and room_id = p_room_id
       and id is distinct from p_exclude_id
       and p_start < end_time and p_end > start_time limit 1;
    if found then
      select room_name into v_name from public.rooms where id = p_room_id;
      v_problems := v_problems || format('Schedule Conflict: %s is already occupied on %s from %s–%s.',
        v_name, p_day, to_char(v_row.start_time, 'FMHH12:MI AM'), to_char(v_row.end_time, 'FMHH12:MI AM'));
    end if;
  end if;

  -- Teacher
  select * into v_row from public.schedules
   where period_id = v_period and day = p_day and teacher_id = p_teacher_id
     and id is distinct from p_exclude_id
     and p_start < end_time and p_end > start_time limit 1;
  if found then
    select teacher_name into v_name from public.teachers where id = p_teacher_id;
    v_problems := v_problems || format('Schedule Conflict: %s already has a class on %s from %s–%s.',
      v_name, p_day, to_char(v_row.start_time, 'FMHH12:MI AM'), to_char(v_row.end_time, 'FMHH12:MI AM'));
  end if;

  -- Program + Year Level
  select * into v_row from public.schedules
   where period_id = v_period and day = p_day
     and program_id = p_program_id and year_level_id = p_year_level_id
     and id is distinct from p_exclude_id
     and p_start < end_time and p_end > start_time limit 1;
  if found then
    v_problems := v_problems || format('Schedule Conflict: this Program and Year Level already has a class on %s from %s–%s.',
      p_day, to_char(v_row.start_time, 'FMHH12:MI AM'), to_char(v_row.end_time, 'FMHH12:MI AM'));
  end if;

  -- Break time
  for v_break in
    select * from public.break_periods where p_start < end_time and p_end > start_time order by start_time
  loop
    v_problems := v_problems || format('Break Time: this class overlaps the %s (%s–%s).',
      v_break.label, to_char(v_break.start_time, 'FMHH12:MI AM'), to_char(v_break.end_time, 'FMHH12:MI AM'));
  end loop;

  -- Maximum teacher load (hours per week, drafts and published both count)
  select coalesce(sum(extract(epoch from (end_time - start_time)) / 3600), 0) into v_current
    from public.schedules
   where period_id = v_period and teacher_id = p_teacher_id and id is distinct from p_exclude_id;
  v_new := extract(epoch from (p_end - p_start)) / 3600;
  select teacher_name, max_load_hours into v_name, v_max from public.teachers where id = p_teacher_id;
  if v_max is not null and v_current + v_new > v_max then
    v_problems := v_problems || format('Max Load: %s would have %s hours per week, but the limit is %s.',
      v_name, round(v_current + v_new, 1), v_max);
  end if;

  return v_problems;
end;
$$;

revoke all on function public.schedule_problems(bigint,bigint,bigint,bigint,bigint,text,time,time) from public, anon;
grant execute on function public.schedule_problems(bigint,bigint,bigint,bigint,bigint,text,time,time) to authenticated;

-- ---------- 5. Create (same name and arguments as before) ----------
create or replace function public.create_schedule(
  p_subject_id bigint, p_program_id bigint, p_year_level_id bigint,
  p_teacher_id bigint, p_room_id bigint, p_day text,
  p_start time, p_end time
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_period   bigint;
  v_problems text[];
  v_id       bigint;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if p_end <= p_start then
    return jsonb_build_object('ok', false, 'error', 'End time must be after start time');
  end if;
  select id into v_period from public.scheduling_periods where is_active limit 1;
  if v_period is null then
    return jsonb_build_object('ok', false, 'error', 'No active scheduling period');
  end if;

  v_problems := public.schedule_problems(null, p_program_id, p_year_level_id, p_teacher_id, p_room_id, p_day, p_start, p_end);
  if array_length(v_problems, 1) > 0 then
    return jsonb_build_object('ok', false, 'error', 'Schedule Conflict', 'conflicts', to_jsonb(v_problems));
  end if;

  begin
    insert into public.schedules
      (period_id, subject_id, program_id, year_level_id, teacher_id, room_id, day, start_time, end_time, status)
    values
      (v_period, p_subject_id, p_program_id, p_year_level_id, p_teacher_id, p_room_id, p_day, p_start, p_end, 'DRAFT')
    returning id into v_id;
  exception
    when exclusion_violation then
      return jsonb_build_object('ok', false, 'error', 'Schedule Conflict',
        'conflicts', jsonb_build_array('Schedule Conflict: this time was just taken. Check again.'));
    when foreign_key_violation then
      return jsonb_build_object('ok', false, 'error', 'One of the selected items does not exist');
    when check_violation then
      return jsonb_build_object('ok', false, 'error', 'Invalid day or time');
  end;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ---------- 6. Edit a schedule (keeps its current status) ----------
create or replace function public.update_schedule(
  p_id bigint, p_subject_id bigint, p_program_id bigint, p_year_level_id bigint,
  p_teacher_id bigint, p_room_id bigint, p_day text,
  p_start time, p_end time
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_problems text[];
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if p_end <= p_start then
    return jsonb_build_object('ok', false, 'error', 'End time must be after start time');
  end if;
  perform 1 from public.schedules where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Schedule not found');
  end if;

  -- p_id is excluded so a schedule never conflicts with itself
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
      return jsonb_build_object('ok', false, 'error', 'Invalid day or time');
  end;

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

revoke all on function public.update_schedule(bigint,bigint,bigint,bigint,bigint,bigint,text,time,time) from public, anon;
grant execute on function public.update_schedule(bigint,bigint,bigint,bigint,bigint,bigint,text,time,time) to authenticated;

-- ---------- 7. Student view: add program and year so students can search any subject ----------
create or replace view public.student_schedule as
select s.id, s.program_id, s.year_level_id, s.day, s.start_time, s.end_time,
       sub.subject_code, sub.subject_name, sub.units,
       t.teacher_name, r.room_name,
       pr.program_name, y.year_level
from public.schedules s
join public.scheduling_periods p on p.id = s.period_id and p.is_active
join public.subjects sub  on sub.id = s.subject_id
join public.teachers t    on t.id = s.teacher_id
join public.rooms r       on r.id = s.room_id
join public.programs pr   on pr.id = s.program_id
join public.year_levels y on y.id = s.year_level_id
where s.status = 'PUBLISHED';
