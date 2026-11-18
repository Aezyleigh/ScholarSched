-- ScholarSched v6: allow different programs to share the exact same class meeting.
-- Requires migrations v2 through v5.

begin;

-- The trigger below is the authoritative concurrency-safe conflict check. These
-- exclusions cannot express a shared meeting, so room/teacher conflicts move to it.
alter table public.schedules drop constraint if exists no_room_overlap;
alter table public.schedules drop constraint if exists no_teacher_overlap;

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
  if v_period is null then return array['No active scheduling period']; end if;
  if p_start < time '08:00' then v_problems := v_problems || 'Classes cannot start before 8:00 AM.'; end if;
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

  select is_online into v_online from public.rooms where id = p_room_id;
  if not coalesce(v_online, false) then
    select * into v_row from public.schedules s
     where s.period_id = v_period and s.day = p_day and s.room_id = p_room_id
       and not (s.id = any(coalesce(array_remove(p_exclude_ids, null), '{}'::bigint[])))
       and not (s.program_id <> p_program_id and s.teacher_id = p_teacher_id
         and s.start_time = p_start and s.end_time = p_end)
       and p_start < s.end_time and p_end > s.start_time limit 1;
    if found then
      select room_name into v_name from public.rooms where id = p_room_id;
      v_problems := v_problems || format('Schedule Conflict: %s is already occupied on %s from %s-%s.',
        v_name, p_day, to_char(v_row.start_time, 'FMHH12:MI AM'), to_char(v_row.end_time, 'FMHH12:MI AM'));
    end if;
  end if;

  select * into v_row from public.schedules s
   where s.period_id = v_period and s.day = p_day and s.teacher_id = p_teacher_id
     and not (s.id = any(coalesce(array_remove(p_exclude_ids, null), '{}'::bigint[])))
     and not (s.program_id <> p_program_id and s.room_id = p_room_id
       and s.start_time = p_start and s.end_time = p_end)
     and p_start < s.end_time + interval '30 minutes'
     and p_end + interval '30 minutes' > s.start_time limit 1;
  if found then
    select teacher_name into v_name from public.teachers where id = p_teacher_id;
    v_problems := v_problems || format('Break required: %s needs at least 30 minutes between classes on %s.', v_name, p_day);
  end if;

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
    select b.* from public.break_periods b
    where p_start < b.end_time and p_end > b.start_time
      and not (p_start <= b.start_time and p_end >= b.end_time)
    order by b.start_time
  loop
    v_problems := v_problems || format('Break Time: this class overlaps the %s (%s-%s).',
      v_break.label, to_char(v_break.start_time, 'FMHH12:MI AM'), to_char(v_break.end_time, 'FMHH12:MI AM'));
  end loop;

  select coalesce(sum(extract(epoch from (m.end_time - m.start_time)) / 3600), 0) into v_current
    from (select distinct s.period_id, s.teacher_id, s.subject_id, s.room_id, s.day, s.start_time, s.end_time
            from public.schedules s
           where s.period_id = v_period and s.teacher_id = p_teacher_id
             and (not (s.id = any(coalesce(array_remove(p_exclude_ids, null), '{}'::bigint[])))
               or (s.program_id <> p_program_id and s.room_id = p_room_id and s.day = p_day
                 and s.start_time = p_start and s.end_time = p_end))) m;
  v_new := case when exists (
    select 1 from public.schedules s where s.period_id = v_period
      and s.program_id <> p_program_id and s.teacher_id = p_teacher_id and s.room_id = p_room_id
      and s.day = p_day and s.start_time = p_start and s.end_time = p_end
  ) then 0 else extract(epoch from (p_end - p_start)) / 3600 end;
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

-- Only an exact cross-program meeting is excluded before the shared checker runs.
create or replace function public.enforce_schedule_rules() returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  v_period bigint;
  v_problems text[];
  v_exclude_ids bigint[];
begin
  perform pg_advisory_xact_lock(73121, 1);
  select id into v_period from public.scheduling_periods where is_active limit 1;
  if new.period_id is distinct from v_period then
    raise exception 'The active scheduling period changed. Refresh and try again.';
  end if;
  select array[new.id] || coalesce(array_agg(s.id), '{}'::bigint[]) into v_exclude_ids
    from public.schedules s
   where s.period_id = new.period_id and s.id <> new.id
     and s.program_id <> new.program_id
     and s.subject_id = new.subject_id and s.teacher_id = new.teacher_id
     and s.room_id = new.room_id and s.day = new.day
     and s.start_time = new.start_time and s.end_time = new.end_time;
  v_problems := public.schedule_problems_all(v_exclude_ids, new.program_id, new.year_level_id,
    new.teacher_id, new.room_id, new.day, new.start_time, new.end_time, 1);
  if cardinality(v_problems) > 0 then
    raise exception '%', array_to_string(v_problems, ' ') using errcode = '23P01';
  end if;
  return new;
end;
$$;

commit;
