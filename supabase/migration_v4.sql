-- ScholarSched v4: period setup, period copying, and conflict suggestions.
-- Requires migration_v3.sql.

begin;

alter table public.scheduling_periods
  add column if not exists starts_on date,
  add column if not exists ends_on date;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'scheduling_period_dates_valid'
      and conrelid = 'public.scheduling_periods'::regclass
  ) then
    alter table public.scheduling_periods add constraint scheduling_period_dates_valid
      check ((starts_on is null) = (ends_on is null) and (starts_on is null or starts_on <= ends_on));
  end if;
  if exists (
    select 1 from public.scheduling_periods group by academic_year, semester having count(*) > 1
  ) then
    raise exception 'Duplicate academic-year/semester periods exist; resolve them before applying migration_v4.sql.';
  end if;
end;
$$;
create unique index if not exists scheduling_period_year_semester_uidx
  on public.scheduling_periods (academic_year, semester);

-- Serialize period switches with writes. Reject stale schedule saves that selected the old active period.
create or replace function public.enforce_schedule_rules() returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  v_period bigint;
  v_problems text[];
begin
  perform pg_advisory_xact_lock(73121, 1);
  select id into v_period from public.scheduling_periods where is_active limit 1;
  if new.period_id is distinct from v_period then
    raise exception 'The active scheduling period changed. Refresh and try again.';
  end if;
  v_problems := public.schedule_problems_all(array[new.id], new.program_id, new.year_level_id,
    new.teacher_id, new.room_id, new.day, new.start_time, new.end_time, 1);
  if cardinality(v_problems) > 0 then
    raise exception '%', array_to_string(v_problems, ' ') using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.close_active_scheduling_period()
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_count integer;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  perform pg_advisory_xact_lock(73121, 1);
  update public.scheduling_periods set is_active = false where is_active;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'closed', v_count > 0);
end;
$$;

create or replace function public.activate_scheduling_period(p_period_id bigint)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_schedule public.schedules%rowtype;
  v_problems text[];
  v_semester text;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if not exists (select 1 from public.scheduling_periods where id = p_period_id) then
    return jsonb_build_object('ok', false, 'error', 'Scheduling period not found');
  end if;
  perform pg_advisory_xact_lock(73121, 1);
  update public.scheduling_periods set is_active = false where is_active and id <> p_period_id;
  update public.scheduling_periods set is_active = true where id = p_period_id;
  select semester into v_semester from public.scheduling_periods where id = p_period_id;
  for v_schedule in select * from public.schedules where period_id = p_period_id order by day, start_time, id loop
    if not exists (select 1 from public.curriculum_courses c where c.subject_id = v_schedule.subject_id
      and c.program_id = v_schedule.program_id and c.year_level_id = v_schedule.year_level_id and c.semester = v_semester) then
      raise exception 'Period cannot start; schedule % is not assigned to this semester curriculum.', v_schedule.id;
    end if;
    v_problems := public.schedule_problems_all(array[v_schedule.id], v_schedule.program_id, v_schedule.year_level_id,
      v_schedule.teacher_id, v_schedule.room_id, v_schedule.day, v_schedule.start_time, v_schedule.end_time, 1);
    if cardinality(v_problems) > 0 then
      raise exception 'Period cannot start; schedule % failed validation: %', v_schedule.id, array_to_string(v_problems, ' ');
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.create_scheduling_period(
  p_academic_year text, p_semester text, p_starts_on date, p_ends_on date,
  p_copy_from bigint default null
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_period_id bigint;
  v_source public.schedules%rowtype;
  v_partner public.schedules%rowtype;
  v_pair_id bigint;
  v_problems text[];
  v_days text[];
  v_copied integer := 0;
  v_pair_count integer;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if p_academic_year is null or p_semester is null or p_starts_on is null or p_ends_on is null
     or p_academic_year !~ '^[0-9]{4}-[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid academic year, semester, and date range');
  end if;
  if split_part(p_academic_year, '-', 2)::integer <> split_part(p_academic_year, '-', 1)::integer + 1
     or p_semester not in ('1st', '2nd', 'Summer') or p_starts_on > p_ends_on then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid academic year, semester, and date range');
  end if;
  if exists (select 1 from public.scheduling_periods where academic_year = p_academic_year and semester = p_semester) then
    return jsonb_build_object('ok', false, 'error', 'That academic year and semester already exists');
  end if;
  if p_copy_from is not null and not exists (select 1 from public.scheduling_periods where id = p_copy_from) then
    return jsonb_build_object('ok', false, 'error', 'The source period no longer exists');
  end if;

  perform pg_advisory_xact_lock(73121, 1);
  insert into public.scheduling_periods (academic_year, semester, starts_on, ends_on, is_active)
  values (p_academic_year, p_semester, p_starts_on, p_ends_on, false) returning id into v_period_id;
  update public.scheduling_periods set is_active = false where is_active;
  update public.scheduling_periods set is_active = true where id = v_period_id;

  if p_copy_from is not null then
    for v_source in
      select s.* from public.schedules s
       where s.period_id = p_copy_from
         and (s.schedule_pair_id is null or s.id = (select min(p.id) from public.schedules p where p.schedule_pair_id = s.schedule_pair_id))
       order by s.day, s.start_time, s.id
    loop
      if not exists (select 1 from public.curriculum_courses c where c.subject_id = v_source.subject_id
        and c.program_id = v_source.program_id and c.year_level_id = v_source.year_level_id and c.semester = p_semester) then
        raise exception 'Copy stopped at schedule %: its course is not assigned to the new period curriculum.', v_source.id;
      end if;
      if v_source.schedule_pair_id is null then
        v_days := array[v_source.day];
        v_problems := public.schedule_problems_all('{}'::bigint[], v_source.program_id, v_source.year_level_id,
          v_source.teacher_id, v_source.room_id, v_source.day, v_source.start_time, v_source.end_time, 1);
        if cardinality(v_problems) > 0 then
          raise exception 'Copy stopped at schedule %: %', v_source.id, array_to_string(v_problems, ' ');
        end if;
        insert into public.schedules
          (period_id, subject_id, program_id, year_level_id, teacher_id, room_id, day, start_time, end_time, status)
        values
          (v_period_id, v_source.subject_id, v_source.program_id, v_source.year_level_id, v_source.teacher_id,
           v_source.room_id, v_source.day, v_source.start_time, v_source.end_time, 'DRAFT');
        v_copied := v_copied + 1;
      else
        select count(*) into v_pair_count from public.schedules where schedule_pair_id = v_source.schedule_pair_id;
        if v_pair_count <> 2 then
          raise exception 'Copy stopped: paired schedule % does not have exactly two rows.', v_source.schedule_pair_id;
        end if;
        select * into v_partner from public.schedules
         where schedule_pair_id = v_source.schedule_pair_id and id <> v_source.id limit 1;
        if v_partner.period_id <> v_source.period_id
           or v_partner.subject_id <> v_source.subject_id or v_partner.program_id <> v_source.program_id
           or v_partner.year_level_id <> v_source.year_level_id or v_partner.teacher_id <> v_source.teacher_id
           or v_partner.room_id <> v_source.room_id or v_partner.start_time <> v_source.start_time
           or v_partner.end_time <> v_source.end_time then
          raise exception 'Copy stopped: paired schedule % has inconsistent rows.', v_source.schedule_pair_id;
        end if;
        v_days := array[v_source.day, v_partner.day];
        v_problems := public.schedule_problems_all('{}'::bigint[], v_source.program_id, v_source.year_level_id,
          v_source.teacher_id, v_source.room_id, v_source.day, v_source.start_time, v_source.end_time, 2)
          || public.schedule_problems_all('{}'::bigint[], v_source.program_id, v_source.year_level_id,
          v_source.teacher_id, v_source.room_id, v_partner.day, v_source.start_time, v_source.end_time, 2);
        if not ((v_days[1] in ('Monday','Wednesday') and v_days[2] in ('Monday','Wednesday') and v_days[1] <> v_days[2])
             or (v_days[1] in ('Tuesday','Thursday') and v_days[2] in ('Tuesday','Thursday') and v_days[1] <> v_days[2])) then
          v_problems := array_append(v_problems, 'Paired schedules must use Monday/Wednesday or Tuesday/Thursday.');
        end if;
        if cardinality(v_problems) > 0 then
          raise exception 'Copy stopped at paired schedule %: %', v_source.schedule_pair_id, array_to_string(v_problems, ' ');
        end if;
        v_pair_id := nextval('public.schedule_pair_id_seq');
        insert into public.schedules
          (period_id, subject_id, program_id, year_level_id, teacher_id, room_id, day, start_time, end_time, status, schedule_pair_id)
        values
          (v_period_id, v_source.subject_id, v_source.program_id, v_source.year_level_id, v_source.teacher_id,
           v_source.room_id, v_source.day, v_source.start_time, v_source.end_time, 'DRAFT', v_pair_id),
          (v_period_id, v_partner.subject_id, v_partner.program_id, v_partner.year_level_id, v_partner.teacher_id,
           v_partner.room_id, v_partner.day, v_partner.start_time, v_partner.end_time, 'DRAFT', v_pair_id);
        v_copied := v_copied + 2;
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'period_id', v_period_id, 'copied_schedules', v_copied);
end;
$$;

create or replace function public.suggest_schedule_options(
  p_program_id bigint, p_year_level_id bigint, p_teacher_id bigint, p_room_id bigint,
  p_days text[], p_start time, p_end time, p_exclude_ids bigint[] default '{}'::bigint[]
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_room public.rooms%rowtype;
  v_day text;
  v_time time;
  v_active_period bigint;
  v_problems text[];
  v_count integer;
  v_rooms jsonb := '[]'::jsonb;
  v_times jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if p_days is null or cardinality(p_days) not between 1 and 2 or p_start is null or p_end is null
     or p_end - p_start <> interval '2 hours 30 minutes' then
    return jsonb_build_object('ok', false, 'error', 'Invalid schedule suggestion request');
  end if;
  select id into v_active_period from public.scheduling_periods where is_active limit 1;
  if v_active_period is null then return jsonb_build_object('ok', false, 'error', 'No active scheduling period'); end if;

  foreach v_day in array p_days loop
    if v_day not in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') then
      return jsonb_build_object('ok', false, 'error', 'Invalid day');
    end if;
  end loop;
  if cardinality(p_days) = 2 and not ((p_days[1] in ('Monday','Wednesday') and p_days[2] in ('Monday','Wednesday') and p_days[1] <> p_days[2])
       or (p_days[1] in ('Tuesday','Thursday') and p_days[2] in ('Tuesday','Thursday') and p_days[1] <> p_days[2])) then
    return jsonb_build_object('ok', false, 'error', 'Invalid paired days');
  end if;

  for v_room in select * from public.rooms where availability = 'Available' order by room_name loop
    v_problems := '{}';
    foreach v_day in array p_days loop
      v_problems := v_problems || public.schedule_problems_all(coalesce(p_exclude_ids, '{}'::bigint[]),
        p_program_id, p_year_level_id, p_teacher_id, v_room.id, v_day, p_start, p_end, cardinality(p_days));
    end loop;
    if cardinality(v_problems) = 0 and jsonb_array_length(v_rooms) < 5 then
      v_rooms := v_rooms || jsonb_build_array(jsonb_build_object('id', v_room.id, 'name', v_room.room_name));
    end if;
  end loop;

  v_time := time '08:00';
  if not exists (select 1 from public.rooms where id = p_room_id and availability = 'Available') then
    v_time := time '18:00';
  end if;
  while v_time <= time '17:30' and jsonb_array_length(v_times) < 8 loop
    if v_time <> p_start then
      v_problems := '{}';
      foreach v_day in array p_days loop
        v_problems := v_problems || public.schedule_problems_all(coalesce(p_exclude_ids, '{}'::bigint[]),
          p_program_id, p_year_level_id, p_teacher_id, p_room_id, v_day, v_time, v_time + interval '150 minutes', cardinality(p_days));
      end loop;
      if cardinality(v_problems) = 0 then
        v_times := v_times || jsonb_build_array(jsonb_build_object('start', v_time, 'end', v_time + interval '150 minutes'));
      end if;
    end if;
    v_time := v_time + interval '30 minutes';
  end loop;
  return jsonb_build_object('ok', true, 'rooms', v_rooms, 'times', v_times);
end;
$$;

revoke all on function public.close_active_scheduling_period() from public, anon;
revoke all on function public.activate_scheduling_period(bigint) from public, anon;
revoke all on function public.create_scheduling_period(text,text,date,date,bigint) from public, anon;
revoke all on function public.suggest_schedule_options(bigint,bigint,bigint,bigint,text[],time,time,bigint[]) from public, anon;
grant execute on function public.close_active_scheduling_period() to authenticated;
grant execute on function public.activate_scheduling_period(bigint) to authenticated;
grant execute on function public.create_scheduling_period(text,text,date,date,bigint) to authenticated;
grant execute on function public.suggest_schedule_options(bigint,bigint,bigint,bigint,text[],time,time,bigint[]) to authenticated;

commit;
