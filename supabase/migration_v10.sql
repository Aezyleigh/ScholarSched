-- ScholarSched v10: schedule the 2025-2026 academic year.
-- Requires migrations v2 through v9.
--
-- The school's available data is the 1st and 2nd Semester of 2025-2026, so those
-- two periods are created here and the active period moves to 2025-2026. Only one
-- semester can receive schedules at a time (the database allows a single active
-- period); the Program Head switches between them under Rooms & Periods.
-- Existing periods, and their schedules, are kept.

begin;

insert into public.scheduling_periods (academic_year, semester, is_active)
select '2025-2026', '1st', false
where not exists (
  select 1 from public.scheduling_periods where academic_year = '2025-2026' and semester = '1st'
);

insert into public.scheduling_periods (academic_year, semester, is_active)
select '2025-2026', '2nd', false
where not exists (
  select 1 from public.scheduling_periods where academic_year = '2025-2026' and semester = '2nd'
);

-- Start the year with 1st Semester active, unless 2025-2026 is already the active
-- year (for example when re-running this migration after switching semesters).
do $$
declare
  v_active public.scheduling_periods%rowtype;
  v_target bigint;
begin
  select * into v_active from public.scheduling_periods where is_active limit 1;
  if v_active.id is not null and v_active.academic_year = '2025-2026' then
    return;
  end if;

  select id into v_target
    from public.scheduling_periods
   where academic_year = '2025-2026' and semester = '1st';

  update public.scheduling_periods set is_active = false where is_active and id <> v_target;
  update public.scheduling_periods set is_active = true where id = v_target;
end;
$$;

commit;
