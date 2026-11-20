-- ScholarSched v11: one course list per program, year level and semester, and
-- account management that can edit emails and create logins that work at once.
-- Requires migrations v2 through v10. Run this whole file once in the Supabase SQL editor.

begin;

-- ---------- Curriculum years are gone ----------
-- A curriculum is now simply the course list for a program, year level and
-- semester. Rows that were split across curriculum years are merged, keeping the
-- oldest row for each course.
alter table public.curriculum_courses drop constraint if exists curriculum_courses_year_fk;
alter table public.curriculum_courses drop constraint if exists curriculum_courses_unique;
alter table public.curriculum_courses
  drop constraint if exists curriculum_courses_subject_id_program_id_year_level_id_semester_key;

delete from public.curriculum_courses a
using public.curriculum_courses b
where a.id > b.id
  and a.subject_id    = b.subject_id
  and a.program_id    = b.program_id
  and a.year_level_id = b.year_level_id
  and a.semester      = b.semester;

alter table public.curriculum_courses drop column if exists valid_years;

alter table public.curriculum_courses
  add constraint curriculum_courses_unique
  unique (subject_id, program_id, year_level_id, semester);

drop table if exists public.curriculum_years;

-- ---------- Account emails ----------
-- Profiles carry the login email so the Program Head can see and change it.
alter table public.profiles add column if not exists email text;

update public.profiles p
   set email = lower(u.email)
  from auth.users u
 where u.id = p.user_id
   and (p.email is null or lower(p.email) is distinct from lower(u.email));

-- ---------- Create a login that works immediately ----------
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Signing up from the browser cannot confirm the address, so a new account could
-- not log in until the confirmation email was clicked. This helper runs with the
-- owner's rights and writes a confirmed login instead.
create or replace function public.admin_create_staff(
  p_name text, p_email text, p_password text, p_role text, p_teacher_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name  text := trim(coalesce(p_name, ''));
  v_id    uuid;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'error', 'Enter the full name for this account');
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid email address');
  end if;
  if length(coalesce(p_password, '')) < 6 then
    return jsonb_build_object('ok', false, 'error', 'Use a password with at least 6 characters');
  end if;
  if p_role not in ('admin', 'teacher') then
    return jsonb_build_object('ok', false, 'error', 'Choose Program Head or Teacher');
  end if;
  if p_role = 'teacher' and p_teacher_id is not null
     and not exists (select 1 from public.teachers where id = p_teacher_id) then
    return jsonb_build_object('ok', false, 'error', 'That faculty record no longer exists');
  end if;

  select id into v_id from auth.users where lower(email) = v_email limit 1;

  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      crypt(p_password, gen_salt('bf')), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('name', v_name),
      '', '', '', ''
    );

    -- Best effort: password sign-in reads auth.users, so a failure here is harmless.
    begin
      insert into auth.identities
        (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values
        (gen_random_uuid(), v_id::text, v_id,
         jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
         'email', now(), now(), now());
    exception when others then null;
    end;
  else
    -- The login already exists (for example from an earlier attempt), so give it
    -- the new password and confirm it instead of creating a duplicate.
    update auth.users
       set encrypted_password = crypt(p_password, gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now(),
           raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
             || jsonb_build_object('name', v_name)
     where id = v_id;
  end if;

  insert into public.profiles (user_id, name, role, teacher_id, email)
  values (v_id, v_name, p_role, case when p_role = 'teacher' then p_teacher_id end, v_email)
  on conflict (user_id) do update
    set name = excluded.name,
        role = excluded.role,
        teacher_id = excluded.teacher_id,
        email = excluded.email;

  return jsonb_build_object('ok', true, 'user_id', v_id);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'That email is already used by another account');
end;
$$;

revoke all on function public.admin_create_staff(text, text, text, text, bigint) from public, anon;
grant execute on function public.admin_create_staff(text, text, text, text, bigint) to authenticated;

-- ---------- Change the email of an existing account ----------
create or replace function public.admin_update_staff_email(p_user_id uuid, p_email text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'You do not have permission to do this');
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid email address');
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email and id <> p_user_id) then
    return jsonb_build_object('ok', false, 'error', 'Another account already uses that email');
  end if;

  update auth.users
     set email = v_email,
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That account no longer exists');
  end if;

  update public.profiles set email = v_email where user_id = p_user_id;

  return jsonb_build_object('ok', true);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'Another account already uses that email');
end;
$$;

revoke all on function public.admin_update_staff_email(uuid, text) from public, anon;
grant execute on function public.admin_update_staff_email(uuid, text) to authenticated;

commit;
