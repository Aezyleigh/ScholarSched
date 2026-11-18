-- ScholarSched v5: allow a class to span an entire configured break.
-- Requires migration_v4.sql.

begin;

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
      v_problems := v_problems || format('Schedule Conflict: %s is already occupied on %s from %s�%s.',
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
    select b.* from public.break_periods b
    where p_start < b.end_time and p_end > b.start_time
      and not (p_start <= b.start_time and p_end >= b.end_time)
    order by b.start_time
  loop
    v_problems := v_problems || format('Break Time: this class overlaps the %s (%s–%s).',
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

commit;
