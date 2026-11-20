const $ = (id) => document.getElementById(id);
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null; // { id, name, role, teacher_id }
let staffRows = [];     // schedules shown to the signed-in staff member
let lookups = { subjects: [], programs: [], years: [], teachers: [], rooms: [], availability: [], curriculum: [], periods: [] };
let currentPeriod = null;
let editingPeriodId = null;
let selectedScheduleIds = new Set();
let studentRows = [];
let reportRows = [];
let reportScheduleRows = [];
let reportTitle = 'Schedule report';
let studentView = 'table';
let staffView = 'table';
let editingId = null;   // id of the schedule being edited, or null when creating
let editingPairId = null;
let currentSemester = null;
let curriculumLoadError = null;
let periodLoadError = null;
let currentUsers = [];
let cyLimit = 12;           // courses shown in the Add Courses picker before "View more"
let editingSubjectId = null; // course being edited inline in the curriculum list
const SCHOOL_YEAR_LABEL = '2025-2026';   // the only academic year the school schedules
let activeYear = null;                    // academic year of the active period, used for data
let curriculumDefaultsSet = false;

/* ScholarSched covers the 1st and 2nd Semester of 2025-2026 only, so every
   semester picker and period list is limited to that academic year. */
const yearPeriods = () => (lookups.periods || []).filter((p) => p.academic_year === SCHOOL_YEAR_LABEL);

/* Optional v7 tables and columns. Detected once so the app still runs on an older database. */
const caps = { departments: false, roomMeta: false, semesterViews: false, userEmails: false };
const inviteClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'scholarsched-new-account' },
});

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SECOND_DAY = { Monday: 'Wednesday', Wednesday: 'Monday', Tuesday: 'Thursday', Thursday: 'Tuesday' };
const BREAK_MIN = 30;   // minutes required between this program and year level's classes
const BREAK_MAX = 60;   // longest empty gap allowed between them
const DAY_START = 7 * 60;   // room availability is shown between 7:00 AM ...
const DAY_END = 20 * 60;    // ... and 8:00 PM

function cleanAlertText(value) {
  return String(value ?? '').replaceAll('—', ' ');
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function escAttr(value) {           // esc() leaves quotes alone, so escape them for input values
  return esc(value).replace(/"/g, '&quot;');
}

function to12h(time) {               // "08:00:00" -> "8:00 AM"
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
const hoursOf = (s) => (toMin(s.end_time) - toMin(s.start_time)) / 60;
const round1 = (n) => Math.round(n * 10) / 10;

function sortSchedules(rows) {
  return rows.sort((a, b) =>
    DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.start_time.localeCompare(b.start_time));
}

/* ---------- combined classes ----------
   A combined class is two or more courses meeting together: the same teacher,
   room, day, start and end time in the same period. They stay separate curriculum
   rows, but they are one meeting, not a conflict. */

function meetingKey(s) {
  return [
    s.teacher_id ?? s.teacher_name,
    s.room_id ?? s.room_name,
    s.day,
    String(s.start_time).slice(0, 5),
    String(s.end_time).slice(0, 5),
  ].join('|');
}

/* Adds combined_with (the other course codes) to every schedule row. */
function annotateCombined(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = meetingKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  rows.forEach((row) => {
    const others = groups.get(meetingKey(row)).filter((other) => other !== row);
    row.combined_with = others.map((other) => other.subject_code);
    row.combined_meeting = others.length > 0;
  });
  return rows;
}

function meetingGroups(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = meetingKey(row);
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
    groups.get(key).rows.push(row);
  });
  return [...groups.values()];
}

/* Combined courses share one meeting, so they add the teacher's hours only once. */
function teachingHours(rows) {
  const meetings = new Map();
  rows.forEach((row) => meetings.set(meetingKey(row), hoursOf(row)));
  return [...meetings.values()].reduce((sum, hours) => sum + hours, 0);
}

function subjectCell(s) {
  const badge = s.combined_with?.length
    ? ` <span class="badge combined" title="Combined with ${escAttr(s.combined_with.join(', '))}">Combined</span>`
    : '';
  return `${esc(s.subject_code)} — ${esc(s.subject_name)}${badge}`;
}

function roleLabel(role) {
  return { admin: 'Program Head', teacher: 'Teacher' }[role] || role;
}

const isAdmin = () => currentUser?.role === 'admin';

/* ---------- views ---------- */

function showLogin() {
  currentUser = null;
  $('app-view').hidden = true;
  $('student-view').hidden = true;
  $('login-view').hidden = false;
  $('forgot-form').hidden = true;
  $('recovery-form').hidden = true;
  $('forgot-alert').hidden = true;
  $('recovery-alert').hidden = true;
  $('login-form').hidden = false;
  $('login-error').className = 'alert error';
  $('login-error').hidden = true;
}

function showTab(name) {
  ['schedules', 'reports', 'curriculum', 'faculty', 'setup', 'settings'].forEach((t) => {
    const panel = $(`tab-${t}`);
    const tab = document.querySelector(`[data-tab="${t}"]`);
    if (!panel || !tab) return;
    panel.hidden = t !== name;
    tab.setAttribute('aria-selected', String(t === name));
    tab.tabIndex = t === name ? 0 : -1;
  });
  if (name === 'reports') renderReport();
  if (name === 'curriculum') renderCurriculum();
  if (name === 'faculty') renderFaculty();
  if (name === 'setup') renderSetup();
  if (name === 'settings') loadUsers();
}

async function showApp(user) {
  currentUser = user;
  $('login-view').hidden = true;
  $('student-view').hidden = true;
  $('app-view').hidden = false;
  $('user-label').textContent = `${user.name} (${roleLabel(user.role)})`;

  const admin = user.role === 'admin';
  $('app-tabs').hidden = false;
  $('create-panel').hidden = !admin;
  document.querySelectorAll('.admin-only').forEach((el) => (el.hidden = !admin));
  // Editors keep the forms; teachers get read-only tables, reports and lists.
  document.querySelectorAll('.editor-only').forEach((el) => (el.hidden = !admin));
  $('staff-list-toggle').hidden = admin;
  $('staff-weekly-toggle').hidden = admin;
  $('list-title').textContent = admin ? 'All Schedules' : 'My Published Schedule';
  $('search-input').value = '';
  resetForm();
  showTab('schedules');

  await loadLookups();
  await loadSchedules();
}

/* ---------- login / logout ---------- */

async function loadProfile(authUser) {
  const { data, error } = await sb
    .from('profiles')
    .select('name, role, teacher_id')
    .eq('user_id', authUser.id)
    .maybeSingle();
  if (error || !data) return null;
  return { id: authUser.id, ...data };
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('login-error');
  errBox.className = 'alert error';
  errBox.hidden = true;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const done = () => { submitBtn.disabled = false; submitBtn.classList.remove('is-busy'); };
  submitBtn.disabled = true;
  submitBtn.classList.add('is-busy');

  const { data, error } = await sb.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  if (error) {
    errBox.textContent = 'Invalid email or password';
    errBox.hidden = false;
    done();
    return;
  }

  const profile = await loadProfile(data.user);
  if (!profile) {
    await sb.auth.signOut();
    errBox.textContent = 'This account has no role assigned. Ask the Program Head.';
    errBox.hidden = false;
    done();
    return;
  }
  $('login-password').value = '';
  done();
  showApp(profile);
});

$('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut();
  showStudent();
});

/* ---------- forgot and reset password ---------- */

function setLoginPanel(name) {
  $('login-form').hidden = name !== 'login';
  $('forgot-form').hidden = name !== 'forgot';
  $('recovery-form').hidden = name !== 'recovery';
  $('forgot-alert').hidden = true;
  $('recovery-alert').hidden = true;
}

$('forgot-password-btn').addEventListener('click', () => {
  setLoginPanel('forgot');
  $('forgot-email').value = $('login-email').value.trim();
  $('forgot-email').focus();
});
$('forgot-back').addEventListener('click', () => setLoginPanel('login'));

$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('forgot-alert');
  const btn = e.target.querySelector('button[type="submit"]');
  const email = $('forgot-email').value.trim();
  btn.disabled = true;
  btn.classList.add('is-busy');
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${location.origin}${location.pathname}`,
  });
  btn.disabled = false;
  btn.classList.remove('is-busy');
  box.className = error ? 'alert error' : 'alert ok';
  box.textContent = error
    ? `The reset email could not be sent. ${error.message}`
    : `If an account exists for ${email}, a password reset link is on its way. Check the inbox and the spam folder.`;
  box.hidden = false;
});

function showRecovery() {
  $('app-view').hidden = true;
  $('student-view').hidden = true;
  $('login-view').hidden = false;
  setLoginPanel('recovery');
  $('recovery-password').focus();
}

sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') showRecovery();
});

$('recovery-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('recovery-alert');
  const password = $('recovery-password').value;
  if (password !== $('recovery-confirm').value) {
    box.className = 'alert error';
    box.textContent = 'The two passwords do not match.';
    box.hidden = false;
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.classList.add('is-busy');
  const { error } = await sb.auth.updateUser({ password });
  btn.disabled = false;
  btn.classList.remove('is-busy');
  if (error) {
    box.className = 'alert error';
    box.textContent = `The password was not changed. ${error.message}`;
    box.hidden = false;
    return;
  }
  $('recovery-form').reset();
  await sb.auth.signOut();
  setLoginPanel('login');
  const loginBox = $('login-error');
  loginBox.className = 'alert ok';
  loginBox.textContent = 'Password updated. Log in with your new password.';
  loginBox.hidden = false;
});

/* ---------- period label and dropdowns ---------- */

async function loadPeriodLabel() {
  const { data, error } = await sb
    .from('scheduling_periods')
    .select('id, academic_year, semester, starts_on, ends_on')
    .eq('is_active', true)
    .maybeSingle();
  periodLoadError = error;
  if (error) console.error('Active scheduling period lookup failed:', error);
  currentPeriod = data || null;
  currentSemester = data?.semester || null;
  activeYear = data?.academic_year || null;
  $('period-label').textContent = activeYear || SCHOOL_YEAR_LABEL;
  if (data && editingId === null) $('f-semester').value = data.semester;
  updateSemesterNote();
}

/* Explains which semester a new schedule is saved into, with a shortcut when the
   chosen semester has its own period that is not active yet. */
function updateSemesterNote() {
  const note = $('semester-note');
  if (!note) return;
  const semester = $('f-semester').value;
  const label = `${semester} Semester`;
  if (!currentPeriod) {
    note.textContent = 'No scheduling period is active. Start one under Rooms & Periods before saving.';
    return;
  }
  if (semester === currentSemester) {
    note.textContent = `Schedules are saved to the active ${label} period (${currentPeriod.academic_year}).`;
    return;
  }
  const target = yearPeriods().find((p) => p.semester === semester);
  note.innerHTML = `Only the active period can receive schedules. You chose ${esc(label)}, but ${esc(currentSemester)} Semester is active.` +
    (target
      ? ` <button type="button" data-activate-semester="${esc(target.id)}">Switch to ${esc(label)}</button>`
      : ' Start that semester under Rooms & Periods first.');
}
$('semester-note').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-activate-semester]');
  if (!btn) return;
  const period = lookups.periods.find((p) => String(p.id) === btn.dataset.activateSemester);
  if (!period || !confirm(`Start ${period.academic_year} ${period.semester} Semester? The current active period will close.`)) return;
  btn.disabled = true;
  const { data, error } = await sb.rpc('activate_scheduling_period', { p_period_id: period.id });
  if (error || !data?.ok) {
    btn.disabled = false;
    return showFormAlert('error', error?.message || data?.error || 'Could not start that period.');
  }
  await loadLookups();
  await loadSchedules();
  showFormAlert('ok', `${period.academic_year} ${period.semester} Semester is now active.`);
});

function updateSubjectOptions() {
  const programId = $('f-program').value;
  const yearId = $('f-year').value;
  const semester = $('f-semester').value || currentSemester;
  const assigned = new Set(lookups.curriculum
    .filter((c) => String(c.program_id) === programId && String(c.year_level_id) === yearId && c.semester === semester)
    .map((c) => String(c.subject_id)));
  // A course that already meets with this teacher in this room at this time stays
  // selectable even when the chosen program's curriculum does not list it, because
  // the scheduler is adding the other half of a combined class.
  const slot = [$('f-teacher').value, $('f-room').value, $('f-day').value, $('f-start').value, $('f-end').value].join('|');
  staffRows.forEach((row) => {
    const rowSlot = [String(row.teacher_id), String(row.room_id), row.day,
      String(row.start_time).slice(0, 5), String(row.end_time).slice(0, 5)].join('|');
    if (rowSlot === slot) assigned.add(String(row.subject_id));
  });
  if (editingId !== null) assigned.add(String($('f-subject').value));
  const rows = lookups.subjects.filter((s) => assigned.has(String(s.id)));
  const select = $('f-subject');
  const previous = select.value;
  fillSelect('f-subject', rows, (s) => `${s.subject_code} — ${s.subject_name}`, 'Select a course from this curriculum');
  if (rows.some((s) => String(s.id) === previous)) select.value = previous;
  const program = lookups.programs.find((p) => String(p.id) === programId)?.program_name || 'selected program';
  const year = lookups.years.find((y) => String(y.id) === yearId)?.year_level || 'selected year';
  $('subject-note').textContent = curriculumLoadError
    ? 'Could not load curriculum from Supabase. Refresh the page and try again.'
    : periodLoadError
      ? 'Could not load the active scheduling period from Supabase. Refresh the page and try again.'
      : rows.length ? ''
        : semester
          ? `No course is assigned to ${program}, ${year}, for ${semester} Semester. Add it under Curriculum.`
          : 'No scheduling period is set.';
}
$('f-program').addEventListener('change', updateSubjectOptions);
$('f-year').addEventListener('change', updateSubjectOptions);
$('f-semester').addEventListener('change', () => { updateSemesterNote(); updateSubjectOptions(); });
function fillSelect(id, rows, labelFn, placeholder = '') {
  $(id).innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') + rows
    .map((r) => `<option value="${esc(r.id)}">${esc(labelFn(r))}</option>`)
    .join('');
}

async function loadLookups() {
  const teacherCols = `id, teacher_name, email, max_load_hours${caps.departments ? ', department_id' : ''}`;
  const roomCols = `id, room_name, is_online${caps.roomMeta ? ', capacity, room_type' : ''}`;
  const curriculumCols = 'id, subject_id, program_id, year_level_id, semester';
  const [subjects, programs, years, teachers, rooms, availability, curriculum, periods, departments] = await Promise.all([
    sb.from('subjects').select('id, subject_code, subject_name, units').order('subject_code'),
    sb.from('programs').select('id, program_name').order('program_name'),
    sb.from('year_levels').select('id, year_level').order('id'),
    sb.from('teachers').select(teacherCols).order('teacher_name'),
    sb.from('rooms').select(roomCols).order('room_name'),
    sb.from('teacher_availability').select('teacher_id, day, start_time, end_time').order('day'),
    sb.from('curriculum_courses').select(curriculumCols).order('semester'),
    sb.from('scheduling_periods').select('id, academic_year, semester, starts_on, ends_on, is_active').order('academic_year', { ascending: false }),
    caps.departments ? sb.from('departments').select('id, department_name').order('department_name') : Promise.resolve({ data: [] }),
  ]);
  curriculumLoadError = curriculum.error;
  if (curriculum.error) console.error('Curriculum lookup failed:', curriculum.error);
  lookups = {
    subjects: subjects.data || [], programs: programs.data || [], years: years.data || [],
    teachers: teachers.data || [], rooms: rooms.data || [], availability: availability.data || [],
    curriculum: curriculum.data || [], periods: periods.data || [],
    departments: departments.data || [],
  };
  const previousFilters = { program: $('cy-program').value, level: $('cy-level').value, semester: $('cy-semester').value };
  fillSelect('f-program', lookups.programs, (r) => r.program_name);
  fillSelect('f-year', lookups.years, (r) => r.year_level);
  fillSelect('f-teacher', lookups.teachers, (r) => r.teacher_name);
  fillSelect('f-room', lookups.rooms, (r) => r.room_name);
  fillSelect('cy-program', lookups.programs, (r) => r.program_name);
  fillSelect('cy-level', lookups.years, (r) => r.year_level, 'All Year Levels');
  if (previousFilters.program && lookups.programs.some((p) => String(p.id) === previousFilters.program)) $('cy-program').value = previousFilters.program;
  if (previousFilters.level && lookups.years.some((y) => String(y.id) === previousFilters.level)) $('cy-level').value = previousFilters.level;
  if (previousFilters.semester) $('cy-semester').value = previousFilters.semester;
  if (!curriculumDefaultsSet) {
    // Land on a real course list instead of three empty pickers.
    if (lookups.programs.length) $('cy-program').selectedIndex = 0;
    if (lookups.years.length) $('cy-level').value = String(lookups.years[0].id);
    if (!$('cy-semester').value) $('cy-semester').value = '1st';
    curriculumDefaultsSet = true;
  }
  fillSelect('teacher-dept', lookups.departments, (r) => r.department_name, 'No department');
  fillSelect('user-teacher', lookups.teachers, (r) => r.teacher_name, 'Not linked');
  fillSelect('r-program', lookups.programs, (r) => r.program_name);
  fillSelect('r-year', lookups.years, (r) => r.year_level);
  fillSelect('r-teacher', lookups.teachers, (r) => r.teacher_name);
  fillSelect('r-room', lookups.rooms, (r) => r.room_name);
  renderCurriculum();
  renderFaculty();
  renderSetup();
  await loadPeriodLabel();
  updateSubjectOptions();
}

/* One probe per optional feature, so a database without migration v7 still works. */
async function detectCaps() {
  const ok = (query) => query.then(({ error }) => !error).catch(() => false);
  const [departments, roomMeta, semesterViews, userEmails] = await Promise.all([
    ok(sb.from('departments').select('id').limit(1)),
    ok(sb.from('rooms').select('id, capacity, room_type').limit(1)),
    ok(sb.from('student_schedule').select('id, semester').limit(1)),
    ok(sb.from('profiles').select('email').limit(1)),
  ]);
  caps.departments = departments;
  caps.roomMeta = roomMeta;
  caps.semesterViews = semesterViews;
  caps.userEmails = userEmails;
}

function showSetupAlert(id, type, message) {
  const box = $(id);
  box.className = `alert ${type}`;
  box.textContent = cleanAlertText(message);
  box.hidden = false;
  if (window.toast) window.toast(cleanAlertText(message), type);
}

function renderSetup() {
  if (!$('room-body')) return;
  const admin = isAdmin();
  $('room-body').innerHTML = lookups.rooms.map((r) => `
    <tr><td>${esc(r.room_name)}</td>
    <td>${caps.roomMeta ? esc(r.room_type || 'Regular Room') : '<span class="muted">—</span>'}</td>
    <td>${caps.roomMeta ? (r.capacity ? `${esc(r.capacity)} seats` : '<span class="muted">Not set</span>') : '<span class="muted">—</span>'}</td>
    <td>${r.is_online ? 'Online' : 'Physical'}</td><td>${admin ? `
    <button type="button" data-edit-room="${r.id}">Edit</button>
    <button type="button" class="danger" data-remove-room="${r.id}">Remove</button>` : '<span class="muted">View only</span>'}</td></tr>`).join('');
  // Room capacity and type are stored by migration v7. Keep the inputs visible
  // but disabled so the feature is discoverable before the migration runs.
  $('room-type').disabled = !caps.roomMeta;
  $('room-capacity').disabled = !caps.roomMeta;
  $('room-meta-note').hidden = caps.roomMeta;
  $('period-body').innerHTML = yearPeriods().map((p) => `
    <tr><td>${esc(p.academic_year)}</td><td>${esc(p.semester)}</td>
    <td>${esc(p.starts_on || 'Dates not set')} – ${esc(p.ends_on || '')}</td><td>${p.is_active ? 'Active' : 'Closed'}</td><td>${admin ? `
    <button type="button" data-edit-period="${p.id}">Edit</button>
    ${p.is_active ? '<button type="button" data-close-period>Close</button>' : `<button type="button" data-activate-period="${p.id}">Start</button>`}
    <button type="button" class="danger" data-remove-period="${p.id}">Remove</button>` : '<span class="muted">View only</span>'}</td></tr>`).join('');
  $('period-copy').innerHTML = '<option value="">Start empty</option>' + yearPeriods()
    .map((p) => `<option value="${p.id}">${esc(p.academic_year)} ${esc(p.semester)}</option>`).join('');
}

$('room-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-room]');
  if (edit) {
    const row = lookups.rooms.find((r) => String(r.id) === edit.dataset.editRoom);
    if (!row) return;
    $('room-id').value = row.id;
    $('room-name').value = row.room_name;
    $('room-type').value = row.room_type || 'Regular Room';
    $('room-capacity').value = row.capacity ?? '';
    $('room-online').checked = row.is_online;
    $('room-submit').textContent = 'Save Room';
    $('room-cancel').hidden = false;
    return;
  }
  const remove = e.target.closest('[data-remove-room]');
  if (!remove) return;
  const row = lookups.rooms.find((r) => String(r.id) === remove.dataset.removeRoom);
  if (!row || !confirm(`Remove ${row.room_name}? This cannot be undone.`)) return;
  const { data, error } = await sb.from('rooms').delete().eq('id', row.id).select('id');
  if (error) return showSetupAlert('room-alert', 'error', error.code === '23503'
    ? 'This room is used by a schedule. Reassign those schedules first.'
    : 'Could not remove the room. Check your permissions and try again.');
  if (!data?.length) return showSetupAlert('room-alert', 'error', 'Room was not removed. It may no longer exist or you may not have permission.');
  if ($('room-id').value === String(row.id)) $('room-cancel').click();
  showSetupAlert('room-alert', 'ok', 'Room removed.');
  await loadLookups();
});

$('room-cancel').addEventListener('click', () => {
  $('room-form').reset(); $('room-id').value = '';
  $('room-submit').textContent = 'Add Room'; $('room-cancel').hidden = true; $('room-alert').hidden = true;
});
$('room-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('room-id').value;
  const values = { room_name: $('room-name').value.trim(), is_online: $('room-online').checked };
  if (caps.roomMeta) {
    values.room_type = $('room-type').value;
    values.capacity = $('room-capacity').value ? Number($('room-capacity').value) : null;
  }
  const { error } = id
    ? await sb.from('rooms').update(values).eq('id', Number(id))
    : await sb.from('rooms').insert(values);
  if (error) return showSetupAlert('room-alert', 'error', 'Could not save the room. Check that its name is unique.');
  $('room-cancel').click();
  showSetupAlert('room-alert', 'ok', id ? 'Room updated.' : 'Room added.');
  await loadLookups();
});

$('period-body').addEventListener('click', async (e) => {
  if (e.target.closest('[data-close-period]')) {
    if (!confirm('Close the active period? Student and teacher views will show no schedules until another period is started.')) return;
    const { data, error } = await sb.rpc('close_active_scheduling_period');
    if (error || !data?.ok) return showSetupAlert('period-alert', 'error', error?.message || data?.error || 'Could not close the active period.');
    showSetupAlert('period-alert', 'ok', 'Active period closed.');
    await loadLookups(); await loadPeriodLabel(); await loadSchedules();
    return;
  }
  const edit = e.target.closest('[data-edit-period]');
  if (edit) {
    const p = lookups.periods.find((row) => String(row.id) === edit.dataset.editPeriod);
    if (!p) return;
    editingPeriodId = p.id;
    $('period-year').value = p.academic_year;
    $('period-semester').value = p.semester;
    $('period-start').value = p.starts_on || '';
    $('period-end').value = p.ends_on || '';
    $('period-copy').disabled = true;
    $('period-submit').textContent = 'Save Period';
    $('period-cancel').hidden = false;
    return;
  }
  const activate = e.target.closest('[data-activate-period]');
  if (activate) {
    const p = lookups.periods.find((row) => String(row.id) === activate.dataset.activatePeriod);
    if (!p || !confirm(`Start ${p.academic_year} ${p.semester}? The current active period will close.`)) return;
    const { data, error } = await sb.rpc('activate_scheduling_period', { p_period_id: p.id });
    if (error || !data?.ok) return showSetupAlert('period-alert', 'error', error?.message || data?.error || 'Could not start that period.');
    showSetupAlert('period-alert', 'ok', 'Scheduling period started.');
    await loadLookups(); await loadPeriodLabel(); await loadSchedules();
    return;
  }
  const remove = e.target.closest('[data-remove-period]');
  if (!remove) return;
  const p = lookups.periods.find((row) => String(row.id) === remove.dataset.removePeriod);
  if (!p || !confirm(`Remove ${p.academic_year} ${p.semester}? This cannot be undone.`)) return;
  const { data, error } = await sb.from('scheduling_periods').delete().eq('id', p.id).select('id');
  if (error) return showSetupAlert('period-alert', 'error', error.code === '23503'
    ? 'This period contains schedules. Remove or retain those schedules before deleting the period.'
    : 'Could not remove the period. Check your permissions and try again.');
  if (!data?.length) return showSetupAlert('period-alert', 'error', 'Period was not removed. It may no longer exist or you may not have permission.');
  if (String(editingPeriodId) === String(p.id)) $('period-cancel').click();
  showSetupAlert('period-alert', 'ok', 'Scheduling period removed.');
  await loadLookups(); await loadPeriodLabel(); await loadSchedules();
});

$('period-cancel').addEventListener('click', () => {
  editingPeriodId = null; $('period-form').reset(); $('period-copy').disabled = false;
  $('period-submit').textContent = 'Start Period'; $('period-cancel').hidden = true; $('period-alert').hidden = true;
});
$('period-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const year = $('period-year').value.trim();
  if (year !== SCHOOL_YEAR_LABEL)
    return showSetupAlert('period-alert', 'error', `Only the ${SCHOOL_YEAR_LABEL} academic year is used.`);
  if ($('period-start').value > $('period-end').value)
    return showSetupAlert('period-alert', 'error', 'The end date must be on or after the start date.');
  if (editingPeriodId) {
    const { error } = await sb.from('scheduling_periods').update({
      academic_year: year, semester: $('period-semester').value,
      starts_on: $('period-start').value, ends_on: $('period-end').value,
    }).eq('id', editingPeriodId);
    if (error) return showSetupAlert('period-alert', 'error', error.code === '23505'
      ? 'That academic year and semester already exists.' : 'Could not update the period. Check the dates and try again.');
    $('period-cancel').click();
    showSetupAlert('period-alert', 'ok', 'Scheduling period updated.');
    await loadLookups(); await loadPeriodLabel();
    return;
  }
  const copyFrom = $('period-copy').value;
  if (copyFrom && !confirm('Start this period and copy the selected period’s schedules as drafts? All copied schedules will be validated. If any schedule fails validation, the new period will not be created.')) return;
  const { data, error } = await sb.rpc('create_scheduling_period', {
    p_academic_year: year, p_semester: $('period-semester').value,
    p_starts_on: $('period-start').value, p_ends_on: $('period-end').value,
    p_copy_from: copyFrom ? Number(copyFrom) : null,
  });
  if (error || !data?.ok) return showSetupAlert('period-alert', 'error', error?.message || data?.error || 'Could not start the period.');
  $('period-cancel').click();
  showSetupAlert('period-alert', 'ok', `Period started. ${data.copied_schedules || 0} schedules copied as drafts.`);
  await loadLookups(); await loadPeriodLabel(); await loadSchedules();
});

function showCurriculumAlert(id, type, message) {
  const box = $(id);
  box.className = `alert ${type}`;
  box.textContent = cleanAlertText(message);
  box.hidden = false;
  if (window.toast) window.toast(cleanAlertText(message), type);
}

/* The course list for a program, year level and semester. A course appears once. */
function curriculumRows(programId, levelId, semester) {
  return (lookups.curriculum || []).filter((c) =>
    (!programId || String(c.program_id) === String(programId))
    && (!levelId || String(c.year_level_id) === String(levelId))
    && (!semester || c.semester === semester));
}

function renderCurriculum() {
  if (!$('cy-body')) return;
  const subjects = lookups.subjects || [];
  const subjectById = new Map(subjects.map((s) => [String(s.id), s]));
  const programById = new Map(lookups.programs.map((p) => [String(p.id), p]));
  const yearById = new Map(lookups.years.map((y) => [String(y.id), y]));

  const admin = isAdmin();
  $('program-body').innerHTML = lookups.programs.map((p) => `
    <tr><td>${esc(p.program_name)}</td><td>${admin ? `<button type="button" data-edit-program="${p.id}">Edit</button>
    <button type="button" class="danger" data-remove-program="${p.id}">Remove</button>` : '<span class="muted">View only</span>'}</td></tr>`).join('');

  const programId = $('cy-program').value;
  const levelId = $('cy-level').value;
  const semester = $('cy-semester').value;
  const seenCourses = new Set();
  const rows = curriculumRows(programId, levelId, semester)
    .filter((c) => subjectById.has(String(c.subject_id)))
    .filter((c) => {
      const key = String(c.subject_id);
      if (seenCourses.has(key)) return false;   // older databases may repeat a course per curriculum year
      seenCourses.add(key);
      return true;
    })
    .sort((a, b) => {
      const left = subjectById.get(String(a.subject_id)).subject_code;
      const right = subjectById.get(String(b.subject_id)).subject_code;
      return left.localeCompare(right)
        || Number(a.year_level_id) - Number(b.year_level_id)
        || String(a.semester).localeCompare(String(b.semester));
    });

  const ready = Boolean(programId && levelId && semester);
  // Columns that the filters already answer would only repeat themselves.
  const colVisible = {
    level: !levelId,
    semester: !semester,
  };
  document.querySelectorAll('#cy-table thead [data-col]').forEach((th) => {
    th.hidden = !colVisible[th.dataset.col];
  });
  const columnCount = 3 + ['level', 'semester'].filter((key) => colVisible[key]).length;

  $('cy-body').innerHTML = rows.map((c) => {
    const subject = subjectById.get(String(c.subject_id));
    const level = yearById.get(String(c.year_level_id));
    const levelCell = colVisible.level ? `<td>${esc(level ? level.year_level : 'All Year Levels')}</td>` : '';
    const semesterCell = colVisible.semester ? `<td>${esc(c.semester)}</td>` : '';
    if (admin && String(subject.id) === String(editingSubjectId)) {
      return `<tr class="is-editing" data-edit-row="${subject.id}">
        <td colspan="${columnCount}"><div class="cy-edit-form">
          <div class="cy-edit-fields">
            <label>Code <input class="cy-edit-code" value="${escAttr(subject.subject_code)}" maxlength="30"></label>
            <label>Course name <input class="cy-edit-name" value="${escAttr(subject.subject_name)}" maxlength="160"></label>
            <label>Units <input class="cy-edit-units" type="number" min="1" max="32767" value="${escAttr(subject.units)}"></label>
          </div>
          <div class="cy-edit-actions">
            <button type="button" class="primary" data-save-subject="${subject.id}">Save</button>
            <button type="button" data-cancel-edit>Cancel</button>
            <button type="button" class="danger" data-delete-subject="${subject.id}">Delete</button>
          </div></div>
          <span class="cy-edit-note">Changes apply to this course everywhere it is used. Delete removes it from every curriculum.</span></td></tr>`;
    }
    return `<tr><td>${esc(subject.subject_code)} — ${esc(subject.subject_name)}</td>
      <td>${esc(subject.units)}</td>${levelCell}${semesterCell}
      <td>${admin ? `<button type="button" data-edit-subject="${subject.id}">Edit</button>
      <button type="button" class="danger" data-remove-curriculum="${c.id}">Remove</button>` : '<span class="muted">View only</span>'}</td></tr>`;
  }).join('') || `<tr><td colspan="${columnCount}" class="muted">${ready
    ? 'No courses yet for this selection. Add them in step 2.'
    : 'Choose a program, year level and semester in step 1 to see its courses.'}</td></tr>`;

  const programName = programById.get(String(programId))?.program_name || 'All programs';
  const levelName = yearById.get(String(levelId))?.year_level || 'All year levels';
  $('cy-summary').textContent = ready
    ? `${rows.length} ${rows.length === 1 ? 'course' : 'courses'} for ${programName}, ${levelName}, ${semester} Semester.`
    : 'Choose a program, year level and semester to add or edit courses.';

  const canAdd = ready;
  $('cy-add').textContent = 'Add Selected Courses';
  if (!canAdd) {
    $('cy-count').textContent = '';
    $('cy-more').hidden = true;
    $('cy-course-list').innerHTML = '<p class="muted">Choose a program, year level and semester in step 1 first.</p>';
    return;
  }

  const added = new Set(curriculumRows(programId, levelId, semester).map((c) => String(c.subject_id)));
  const term = $('cy-search').value.trim().toLowerCase();
  const list = subjects.filter((s) => !term || `${s.subject_code} ${s.subject_name}`.toLowerCase().includes(term));
  const page = list.slice(0, cyLimit);
  $('cy-count').textContent = `${page.length} of ${list.length} courses`;
  $('cy-more').hidden = page.length >= list.length;
  $('cy-course-list').innerHTML = page.map((s) => {
    const isAdded = added.has(String(s.id));
    return `<label class="${isAdded ? 'is-added' : ''}">
      <input type="checkbox" value="${s.id}" data-cy-course ${isAdded ? 'checked disabled' : ''}>
      <span>${esc(s.subject_code)} — ${esc(s.subject_name)}</span>
      <span class="check-meta">${isAdded ? 'Added' : `${esc(s.units)} units`}</span></label>`;
  }).join('') || '<p class="muted">No course matches that search.</p>';
}

$('program-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-program]');
  if (edit) {
    const row = lookups.programs.find((p) => String(p.id) === edit.dataset.editProgram);
    if (!row) return;
    $('program-id').value = row.id;
    $('program-name').value = row.program_name;
    $('program-submit').textContent = 'Save Program';
    $('program-cancel').hidden = false;
    return;
  }
  const remove = e.target.closest('[data-remove-program]');
  if (!remove) return;
  const row = lookups.programs.find((p) => String(p.id) === remove.dataset.removeProgram);
  if (!row || !confirm(`Remove ${row.program_name}? This cannot be undone.`)) return;
  const { data, error } = await sb.from('programs').delete().eq('id', row.id).select('id');
  if (error) return showCurriculumAlert('program-alert', 'error', error.code === '23503'
    ? 'This program is used by a schedule or curriculum entry. Remove those references first.'
    : 'Could not remove the program. Check your permissions and try again.');
  if (!data?.length) return showCurriculumAlert('program-alert', 'error', 'Program was not removed. It may no longer exist or you may not have permission.');
  if ($('program-id').value === String(row.id)) $('program-cancel').click();
  showCurriculumAlert('program-alert', 'ok', 'Program removed.');
  await loadLookups();
});

$('program-cancel').addEventListener('click', () => {
  $('program-form').reset();
  $('program-id').value = '';
  $('program-submit').textContent = 'Add Program';
  $('program-cancel').hidden = true;
  $('program-alert').hidden = true;
});

$('program-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('program-id').value;
  const values = { program_name: $('program-name').value.trim() };
  const { error } = id
    ? await sb.from('programs').update(values).eq('id', Number(id))
    : await sb.from('programs').insert(values);
  if (error) return showCurriculumAlert('program-alert', 'error', 'Could not save the program. Check that its name is unique.');
  $('program-cancel').click();
  showCurriculumAlert('program-alert', 'ok', id ? 'Program updated.' : 'Program added.');
  await loadLookups();
});

/* ---------- faculty, departments and availability ---------- */

function buildAvailabilityEditor() {
  const box = $('teacher-avail');
  if (!box) return;
  box.innerHTML = DAY_ORDER.map((day) => `
    <div class="avail-row">
      <label class="check-label"><input type="checkbox" data-avail-day="${day}"> ${day}</label>
      <input type="time" data-avail-start="${day}" value="08:00" aria-label="${day} start time" min="06:00" max="21:00">
      <input type="time" data-avail-end="${day}" value="17:00" aria-label="${day} end time" min="06:00" max="21:00">
    </div>`).join('');
  box.addEventListener('change', (e) => {
    const day = e.target.dataset.availDay;
    if (!day) return;
    box.querySelector(`[data-avail-start="${day}"]`).disabled = !e.target.checked;
    box.querySelector(`[data-avail-end="${day}"]`).disabled = !e.target.checked;
  });
}

function setAvailability(rows = []) {
  const box = $('teacher-avail');
  if (!box) return;
  DAY_ORDER.forEach((day) => {
    const row = rows.find((a) => a.day === day);
    const check = box.querySelector(`[data-avail-day="${day}"]`);
    const start = box.querySelector(`[data-avail-start="${day}"]`);
    const end = box.querySelector(`[data-avail-end="${day}"]`);
    check.checked = Boolean(row);
    start.value = row ? String(row.start_time).slice(0, 5) : '08:00';
    end.value = row ? String(row.end_time).slice(0, 5) : '17:00';
    start.disabled = !row;
    end.disabled = !row;
  });
}

function defaultAvailability() {
  return DAY_ORDER.map((day) => ({ day, start_time: '08:00', end_time: '17:00' }));
}

async function saveAvailability(teacherId) {
  const rows = [];
  for (const day of DAY_ORDER) {
    const check = document.querySelector(`#teacher-avail [data-avail-day="${day}"]`);
    if (!check || !check.checked) continue;
    const start = document.querySelector(`#teacher-avail [data-avail-start="${day}"]`).value;
    const end = document.querySelector(`#teacher-avail [data-avail-end="${day}"]`).value;
    if (!start || !end || end <= start) return `${day}: the end time must be after the start time.`;
    rows.push({ teacher_id: Number(teacherId), day, start_time: start, end_time: end });
  }
  const cleared = await sb.from('teacher_availability').delete().eq('teacher_id', Number(teacherId));
  if (cleared.error) return 'Could not update the availability windows.';
  if (rows.length) {
    const { error } = await sb.from('teacher_availability').insert(rows);
    if (error) return 'Could not save the availability windows.';
  }
  return null;
}

function renderFaculty() {
  if (!$('teacher-body')) return;
  const deptById = new Map((lookups.departments || []).map((d) => [String(d.id), d.department_name]));
  const admin = isAdmin();
  $('teacher-body').innerHTML = lookups.teachers.map((t) => `
    <tr><td>${esc(t.teacher_name)}</td>
      <td>${esc(deptById.get(String(t.department_id)) || '—')}</td>
      <td>${esc(t.email || '—')}</td>
      <td>${esc(t.max_load_hours)} hours</td>
      <td>${esc(availabilityText(t.id))}</td>
      <td>${admin ? `<button type="button" data-edit-teacher="${t.id}">Edit</button>
      <button type="button" class="danger" data-remove-teacher="${t.id}">Remove</button>` : '<span class="muted">View only</span>'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">No teachers yet. Add the first one above.</td></tr>';
  $('teacher-dept').closest('label').hidden = !caps.departments;
  const deptSection = $('dept-form').closest('section');
  if (deptSection) deptSection.hidden = !caps.departments;
  renderDepartments();
}

function renderDepartments() {
  if (!$('dept-body')) return;
  $('dept-body').innerHTML = (lookups.departments || []).map((d) => {
    const count = lookups.teachers.filter((t) => String(t.department_id) === String(d.id)).length;
    return `<tr><td>${esc(d.department_name)}</td><td>${count}</td>
      <td>${isAdmin() ? `<button type="button" data-edit-dept="${d.id}">Edit</button>
      <button type="button" class="danger" data-remove-dept="${d.id}">Remove</button>` : '<span class="muted">View only</span>'}</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted">No departments yet. Add one above.</td></tr>';
}

buildAvailabilityEditor();
setAvailability(defaultAvailability());

$('teacher-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-teacher]');
  if (edit) {
    const row = lookups.teachers.find((t) => String(t.id) === edit.dataset.editTeacher);
    if (!row) return;
    $('teacher-id').value = row.id;
    $('teacher-name').value = row.teacher_name;
    $('teacher-email').value = row.email || '';
    $('teacher-load').value = row.max_load_hours;
    if (caps.departments) $('teacher-dept').value = row.department_id ?? '';
    setAvailability(lookups.availability.filter((a) => String(a.teacher_id) === String(row.id)));
    $('teacher-submit').textContent = 'Save Teacher';
    $('teacher-cancel').hidden = false;
    $('teacher-alert').hidden = true;
    return;
  }
  const remove = e.target.closest('[data-remove-teacher]');
  if (!remove) return;
  const row = lookups.teachers.find((t) => String(t.id) === remove.dataset.removeTeacher);
  if (!row || !confirm(`Remove ${row.teacher_name}? This cannot be undone.`)) return;
  const { data, error } = await sb.from('teachers').delete().eq('id', row.id).select('id');
  if (error) return showCurriculumAlert('teacher-alert', 'error', error.code === '23503'
    ? 'This teacher is assigned to a schedule. Reassign those schedules first.'
    : 'Could not remove the teacher. Check your permissions and try again.');
  if (!data?.length) return showCurriculumAlert('teacher-alert', 'error', 'Teacher was not removed. They may no longer exist or you may not have permission.');
  if ($('teacher-id').value === String(row.id)) $('teacher-cancel').click();
  showCurriculumAlert('teacher-alert', 'ok', 'Teacher removed.');
  await loadLookups();
});

$('teacher-cancel').addEventListener('click', () => {
  $('teacher-form').reset();
  $('teacher-id').value = '';
  $('teacher-submit').textContent = 'Add Teacher';
  $('teacher-cancel').hidden = true;
  $('teacher-alert').hidden = true;
  setAvailability(defaultAvailability());
});

$('teacher-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('teacher-id').value;
  const values = {
    teacher_name: $('teacher-name').value.trim(),
    email: $('teacher-email').value.trim() || null,
    max_load_hours: Number($('teacher-load').value),
  };
  if (caps.departments) {
    values.department_id = $('teacher-dept').value ? Number($('teacher-dept').value) : null;
  }
  let teacherId = id ? Number(id) : null;
  if (id) {
    const { error } = await sb.from('teachers').update(values).eq('id', Number(id));
    if (error) return showCurriculumAlert('teacher-alert', 'error', 'Could not save the teacher. Check the entered details and try again.');
  } else {
    const { data, error } = await sb.from('teachers').insert(values).select('id').single();
    if (error || !data) return showCurriculumAlert('teacher-alert', 'error', 'Could not save the teacher. Check the entered details and try again.');
    teacherId = data.id;
  }
  const problem = await saveAvailability(teacherId);
  if (problem) return showCurriculumAlert('teacher-alert', 'error', problem);
  $('teacher-cancel').click();
  showCurriculumAlert('teacher-alert', 'ok', id ? 'Teacher updated.' : 'Teacher added.');
  await loadLookups();
});

/* ---------- departments ---------- */

$('dept-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-dept]');
  if (edit) {
    const row = lookups.departments.find((d) => String(d.id) === edit.dataset.editDept);
    if (!row) return;
    $('dept-id').value = row.id;
    $('dept-name').value = row.department_name;
    $('dept-submit').textContent = 'Save Department';
    $('dept-cancel').hidden = false;
    return;
  }
  const remove = e.target.closest('[data-remove-dept]');
  if (!remove) return;
  const row = lookups.departments.find((d) => String(d.id) === remove.dataset.removeDept);
  if (!row || !confirm(`Remove ${row.department_name}? Its teachers keep their records but lose the department.`)) return;
  const { error } = await sb.from('departments').delete().eq('id', row.id);
  if (error) return showCurriculumAlert('dept-alert', 'error', 'Could not remove the department. Check your permissions and try again.');
  if ($('dept-id').value === String(row.id)) $('dept-cancel').click();
  showCurriculumAlert('dept-alert', 'ok', 'Department removed.');
  await loadLookups();
});

$('dept-cancel').addEventListener('click', () => {
  $('dept-form').reset();
  $('dept-id').value = '';
  $('dept-submit').textContent = 'Add Department';
  $('dept-cancel').hidden = true;
  $('dept-alert').hidden = true;
});

$('dept-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('dept-id').value;
  const values = { department_name: $('dept-name').value.trim() };
  const { error } = id
    ? await sb.from('departments').update(values).eq('id', Number(id))
    : await sb.from('departments').insert(values);
  if (error) return showCurriculumAlert('dept-alert', 'error', 'Could not save the department. Check that its name is unique.');
  $('dept-cancel').click();
  showCurriculumAlert('dept-alert', 'ok', id ? 'Department updated.' : 'Department added.');
  await loadLookups();
});

function curriculumSelection() {
  return {
    programId: $('cy-program').value,
    levelId: $('cy-level').value,
    semester: $('cy-semester').value,
  };
}

$('cy-program').addEventListener('change', renderCurriculum);
$('cy-level').addEventListener('change', renderCurriculum);
$('cy-semester').addEventListener('change', renderCurriculum);
$('cy-search').addEventListener('input', () => { cyLimit = 12; renderCurriculum(); });
$('cy-more').addEventListener('click', () => { cyLimit += 12; renderCurriculum(); });
$('cy-course-list').addEventListener('change', () => {
  const chosen = document.querySelectorAll('[data-cy-course]:checked:not(:disabled)').length;
  $('cy-add').textContent = chosen ? `Add ${chosen} ${chosen === 1 ? 'course' : 'courses'}` : 'Add Selected Courses';
});
$('cy-add').addEventListener('click', async (e) => {
  const { programId, levelId, semester } = curriculumSelection();
  if (!programId || !levelId || !semester) {
    return showCurriculumAlert('cy-alert', 'error', 'Choose a program, year level and semester before adding courses.');
  }
  const chosen = [...document.querySelectorAll('[data-cy-course]:checked:not(:disabled)')].map((box) => Number(box.value));
  if (!chosen.length) return showCurriculumAlert('cy-alert', 'error', 'Tick at least one course to add.');
  const values = chosen.map((subjectId) => ({
    subject_id: subjectId, program_id: Number(programId), year_level_id: Number(levelId), semester,
  }));
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('is-busy');
  const { error } = await sb.from('curriculum_courses').insert(values);
  btn.disabled = false;
  btn.classList.remove('is-busy');
  if (error) return showCurriculumAlert('cy-alert', 'error', 'Could not add the selected courses. One of them may already be in this curriculum.');
  showCurriculumAlert('cy-alert', 'ok', `${values.length} ${values.length === 1 ? 'course' : 'courses'} added to the curriculum.`);
  await loadLookups();
});

$('cy-quick-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { programId, levelId, semester } = curriculumSelection();
  if (!programId || !levelId || !semester) {
    return showCurriculumAlert('cy-alert', 'error', 'Choose a program, year level and semester first.');
  }
  const subject = {
    subject_code: $('cy-code').value.trim().toUpperCase(),
    subject_name: $('cy-name').value.trim(),
    units: Number($('cy-units').value),
  };
  const { data, error } = await sb.from('subjects').insert(subject).select('id').single();
  if (error || !data) {
    return showCurriculumAlert('cy-alert', 'error', error?.code === '23505'
      ? 'That course code already exists. Tick it in the list instead.'
      : 'Could not create the course. Check the code, name and units.');
  }
  const row = { subject_id: data.id, program_id: Number(programId), year_level_id: Number(levelId), semester };
  const added = await sb.from('curriculum_courses').insert(row);
  if (added.error) {
    return showCurriculumAlert('cy-alert', 'error', 'The course was created but could not be added to this curriculum.');
  }
  $('cy-quick-form').reset();
  $('cy-quick-form').closest('details').open = false;
  showCurriculumAlert('cy-alert', 'ok', `${subject.subject_code} was created and added to the curriculum.`);
  await loadLookups();
});

$('cy-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('button[data-edit-subject]');
  if (edit) {
    editingSubjectId = String(edit.dataset.editSubject);
    renderCurriculum();
    // The row turns into inputs in place, so there is nothing to scroll to.
    document.querySelector('.cy-edit-code')?.focus({ preventScroll: true });
    return;
  }

  if (e.target.closest('[data-cancel-edit]')) {
    editingSubjectId = null;
    renderCurriculum();
    return;
  }

  const save = e.target.closest('button[data-save-subject]');
  if (save) {
    const row = save.closest('tr');
    const values = {
      subject_code: row.querySelector('.cy-edit-code').value.trim().toUpperCase(),
      subject_name: row.querySelector('.cy-edit-name').value.trim(),
      units: Number(row.querySelector('.cy-edit-units').value),
    };
    if (!values.subject_code || !values.subject_name || !values.units) {
      return showCurriculumAlert('cy-alert', 'error', 'A course needs a code, a name and at least one unit.');
    }
    save.disabled = true;
    const { error } = await sb.from('subjects').update(values).eq('id', Number(save.dataset.saveSubject));
    save.disabled = false;
    if (error) {
      return showCurriculumAlert('cy-alert', 'error', error.code === '23505'
        ? 'Another course already uses that code.'
        : 'Could not save the course. Check the code, name and units.');
    }
    editingSubjectId = null;
    showCurriculumAlert('cy-alert', 'ok', `${values.subject_code} updated.`);
    await loadLookups();
    return;
  }

  const del = e.target.closest('button[data-delete-subject]');
  if (del) {
    const course = lookups.subjects.find((row) => String(row.id) === del.dataset.deleteSubject);
    if (!course) return;
    if (!confirm(`Delete ${course.subject_code} — ${course.subject_name}? This removes the course from every curriculum that uses it and cannot be undone.`)) return;
    const { data, error } = await sb.from('subjects').delete().eq('id', Number(course.id)).select('id');
    if (error) {
      return showCurriculumAlert('cy-alert', 'error', error.code === '23503'
        ? 'This course is still used by a schedule or curriculum entry. Remove those first.'
        : 'Could not delete the course. Check your permissions and try again.');
    }
    if (!data?.length) return showCurriculumAlert('cy-alert', 'error', 'Course was not deleted. It may no longer exist or you may not have permission.');
    editingSubjectId = null;
    showCurriculumAlert('cy-alert', 'ok', `${course.subject_code} deleted.`);
    await loadLookups();
    return;
  }

  const remove = e.target.closest('button[data-remove-curriculum]');
  if (!remove) return;
  if (!confirm('Remove this course from the curriculum? The course itself stays in the list.')) return;
  const { error } = await sb.from('curriculum_courses').delete().eq('id', Number(remove.dataset.removeCurriculum));
  if (error) return showCurriculumAlert('cy-alert', 'error', 'Could not remove this curriculum entry.');
  showCurriculumAlert('cy-alert', 'ok', 'Course removed from this curriculum.');
  await loadLookups();
});
/* ---------- schedule table (staff) ---------- */

async function fetchStaffSchedules() {
  if (currentUser.role === 'admin') {
    const { data, error } = await sb
      .from('schedules')
      .select(`id, day, start_time, end_time, status,
               subject_id, program_id, year_level_id, teacher_id, room_id, schedule_pair_id,
               subjects(subject_code, subject_name),
               programs(program_name), year_levels(year_level),
               teachers(teacher_name), rooms(room_name, is_online),
               scheduling_periods!inner(is_active, semester)`)
      .eq('scheduling_periods.is_active', true);
    if (error) return null;
    return data.map((s) => ({
      id: s.id, day: s.day, start_time: s.start_time, end_time: s.end_time, status: s.status,
      subject_id: s.subject_id, program_id: s.program_id, year_level_id: s.year_level_id,
      teacher_id: s.teacher_id, room_id: s.room_id, schedule_pair_id: s.schedule_pair_id,
      subject_code: s.subjects.subject_code, subject_name: s.subjects.subject_name,
      program_name: s.programs.program_name, year_level: s.year_levels.year_level,
      teacher_name: s.teachers.teacher_name, room_name: s.rooms.room_name,
      is_online: s.rooms.is_online,
      semester: s.scheduling_periods?.semester || currentSemester,
    }));
  }
  const { data, error } = await sb.from('teacher_schedule').select('*');
  return error ? null : data;
}

async function loadSchedules() {
  $('staff-table-view').classList.add('is-loading');
  const rows = await fetchStaffSchedules();
  $('staff-table-view').classList.remove('is-loading');
  if (!rows) {
    staffRows = []; selectedScheduleIds.clear();
    $('schedule-body').innerHTML = ''; updateBulkCount();
    $('empty-msg').textContent = 'Could not load schedules. Refresh and try again.'; $('empty-msg').hidden = false;
    return;
  }
  staffRows = sortSchedules(annotateCombined(rows));
  const validIds = new Set(staffRows.map((row) => String(row.id)));
  selectedScheduleIds = new Set([...selectedScheduleIds].filter((id) => validIds.has(id)));
  renderStaffTable();
  updateCombineNote();
  if (!$('tab-reports').hidden) renderReport();
}

/* Search matches combined classes too: a course code, teacher or room shared by
   the meeting shows the whole meeting. */
function visibleStaffGroups() {
  const q = $('search-input').value.trim().toLowerCase();
  return meetingGroups(staffRows).filter((group) => !q || group.rows
    .map((row) => [row.subject_code, row.subject_name, row.teacher_name, row.room_name, row.program_name, row.year_level, row.day, row.status, ...(row.combined_with || [])].join(' '))
    .join(' ').toLowerCase().includes(q));
}

function updateBulkCount() {
  if (!$('bulk-count')) return;
  $('bulk-count').textContent = `${selectedScheduleIds.size} selected`;
  const groups = visibleStaffGroups();
  const checked = groups.filter((group) => group.rows.every((row) => selectedScheduleIds.has(String(row.id)))).length;
  $('select-all-schedules').checked = groups.length > 0 && checked === groups.length;
  $('select-all-schedules').indeterminate = checked > 0 && checked < groups.length;
  $('bulk-publish').disabled = selectedScheduleIds.size === 0;
  $('bulk-unpublish').disabled = selectedScheduleIds.size === 0;
}

async function bulkChangeStatus(status, btn) {
  if (!currentUser || currentUser.role !== 'admin') return;
  const expected = status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED';
  const ids = staffRows.filter((row) => selectedScheduleIds.has(String(row.id)) && row.status === expected).map((row) => row.id);
  if (!ids.length) return showFormAlert('error', `Select at least one ${expected.toLowerCase()} schedule.`);
  const verb = status === 'PUBLISHED' ? 'publish' : 'unpublish';
  if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${ids.length} selected ${ids.length === 1 ? 'schedule' : 'schedules'}? Paired days and combined classes update together.`)) return;
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
  const { data, error } = await sb.from('schedules').update({ status }).in('id', ids).eq('status', expected).select('id');
  if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
  if (error) return showFormAlert('error', `Could not ${verb} the selected schedules. Refresh and try again.`);
  selectedScheduleIds.clear();
  showFormAlert('ok', `${data?.length || 0} selected schedule rows ${status === 'PUBLISHED' ? 'published' : 'returned to draft'}.`);
  await loadSchedules();
}
$('bulk-publish').addEventListener('click', (e) => bulkChangeStatus('PUBLISHED', e.currentTarget));
$('bulk-unpublish').addEventListener('click', (e) => bulkChangeStatus('DRAFT', e.currentTarget));

function renderStaffTable() {
  const isAdmin = currentUser.role === 'admin';
  const groups = visibleStaffGroups();

  $('schedule-body').innerHTML = groups.map((group) => {
    const first = group.rows[0];
    const ids = group.rows.map((row) => row.id);
    const codes = group.rows.map((row) => row.subject_code).join(', ');
    const programs = [...new Set(group.rows.map((row) => `${row.program_name}, ${row.year_level}`))];
    const statuses = [...new Set(group.rows.map((row) => row.status))];
    const status = statuses
      .map((value) => `<span class="badge ${esc(value)}">${esc(value)}</span>`).join(' ');
    return `<tr>
      ${isAdmin ? `<td><input type="checkbox" data-select-schedule="${ids.join(',')}" aria-label="Select ${escAttr(codes)}"${ids.every((id) => selectedScheduleIds.has(String(id))) ? ' checked' : ''}></td>` : ''}
      <td data-label="Subject">${group.rows.map(subjectCell).join('<br>')}${group.rows.length > 1 ? '<span class="combined-note">One combined class: same teacher, room and time.</span>' : ''}</td>
      <td data-label="Program and year">${programs.map(esc).join('<br>')}</td>
      <td data-label="Teacher">${esc(first.teacher_name)}</td>
      <td data-label="Room">${esc(first.room_name)}</td>
      <td data-label="Day">${esc(first.day)}</td>
      <td data-label="Time">${to12h(first.start_time)} — ${to12h(first.end_time)}</td>
      <td data-label="Status">${status}</td>
      ${isAdmin ? `<td class="actions">${actionButtons(group)}</td>` : ''}
    </tr>`;
  }).join('');

  const empty = $('empty-msg');
  empty.hidden = groups.length > 0;
  if (!isAdmin) {
    const rows = groups.flatMap((group) => group.rows);
    $('staff-table-view').hidden = staffView !== 'table';
    $('staff-weekly-view').hidden = staffView !== 'week';
    renderWeeklyGrid(rows, 'staff-weekly-view');
  }
  updateBulkCount();
  if (staffRows.length === 0) {
    empty.textContent = isAdmin ? 'No schedules yet. Create one above.' : 'Nothing is published for you yet.';
  } else {
    empty.textContent = `No schedule matches "${$('search-input').value.trim()}".`;
  }
}

$('search-input').addEventListener('input', renderStaffTable);
$('schedule-body').addEventListener('change', (e) => {
  const box = e.target.closest('[data-select-schedule]');
  if (!box) return;
  String(box.dataset.selectSchedule).split(',').filter(Boolean).forEach((id) => {
    if (box.checked) selectedScheduleIds.add(id);
    else selectedScheduleIds.delete(id);
  });
  updateBulkCount();
});
$('select-all-schedules').addEventListener('change', () => {
  visibleStaffGroups().flatMap((group) => group.rows).forEach((s) => {
    if ($('select-all-schedules').checked) selectedScheduleIds.add(String(s.id));
    else selectedScheduleIds.delete(String(s.id));
  });
  renderStaffTable();
});

/* Actions apply to the whole combined meeting. Each course keeps its own Edit
   button, because a course cannot change subject or program for its partner. */
function actionButtons(group) {
  const rows = group.rows;
  const ids = rows.map((s) => s.id);
  const paired = rows.some((s) => s.schedule_pair_id) ? 'data-paired="true"' : '';
  const edit = rows.length === 1
    ? `<button data-ids="${ids[0]}" ${paired} data-action="edit">Edit</button>`
    : rows.map((s) => `<button data-ids="${s.id}" ${s.schedule_pair_id ? 'data-paired="true"' : ''} data-action="edit">Edit ${esc(s.subject_code)}</button>`).join('');
  const draftIds = rows.filter((s) => s.status === 'DRAFT').map((s) => s.id);
  const publishedIds = rows.filter((s) => s.status === 'PUBLISHED').map((s) => s.id);
  return `${edit}
    ${draftIds.length ? `<button data-ids="${draftIds.join(',')}" ${paired} data-action="publish" class="primary">Publish</button>` : ''}
    ${publishedIds.length ? `<button data-ids="${publishedIds.join(',')}" ${paired} data-action="unpublish">Unpublish</button>` : ''}
    ${draftIds.length ? `<button data-ids="${draftIds.join(',')}" ${paired} data-action="delete" class="danger">Delete</button>` : ''}`;
}

async function changeStatus(id, action) {
  let result;
  const target = (query) => query.eq('id', id);
  if (action === 'publish') {
    result = await target(sb.from('schedules').update({ status: 'PUBLISHED' })).eq('status', 'DRAFT').select();
    return { ok: !result.error && result.data.length > 0, message: 'Published', error: 'Only drafts can be published' };
  }
  if (action === 'unpublish') {
    result = await target(sb.from('schedules').update({ status: 'DRAFT' })).eq('status', 'PUBLISHED').select();
    return { ok: !result.error && result.data.length > 0, message: 'Returned to draft', error: 'Only published schedules can be unpublished' };
  }
  result = await target(sb.from('schedules').delete()).eq('status', 'DRAFT').select();
  return { ok: !result.error && result.data.length > 0, message: 'Draft deleted', error: 'Only drafts can be deleted. Unpublish it first.' };
}

$('schedule-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, paired } = btn.dataset;
  const ids = String(btn.dataset.ids || '').split(',').filter(Boolean).map(Number);
  if (!ids.length) return;

  if (action === 'edit') return startEdit(ids[0]);
  const groupNote = ids.length > 1 ? ` These ${ids.length} course rows are one combined class, so they change together.` : '';
  if (action === 'delete' && !confirm((paired ? 'Delete both draft days in this paired schedule?' : 'Delete this draft schedule?') + groupNote)) return;

  btn.disabled = true;
  btn.classList.add('is-busy');
  const results = [];
  for (const id of ids) results.push(await changeStatus(id, action));
  btn.disabled = false;
  btn.classList.remove('is-busy');
  const failed = results.find((res) => !res.ok);
  if (failed) showFormAlert('error', failed.error);
  else showFormAlert('ok', ids.length > 1 ? `${results.length} combined schedules ${results[0].message.toLowerCase()}.` : results[0].message);
  loadSchedules();
});

/* ---------- create and edit schedule ---------- */

function showFormAlert(type, message, list = []) {
  const box = $('form-alert');
  box.className = `alert ${type}`;
  box.innerHTML = esc(cleanAlertText(message)) +
    (list.length ? `<ul>${list.map((c) => `<li>${esc(cleanAlertText(c))}</li>`).join('')}</ul>` : '');
  box.hidden = false;
  if (window.toast) window.toast(cleanAlertText(message), type);
}

async function showConflictSuggestions(args, days) {
  const excludeIds = editingId === null ? [] : (editingPairId
    ? staffRows.filter((row) => row.schedule_pair_id === editingPairId).map((row) => row.id)
    : [editingId]);
  const { data, error } = await sb.rpc('suggest_schedule_options', {
    p_program_id: args.p_program_id, p_year_level_id: args.p_year_level_id,
    p_teacher_id: args.p_teacher_id, p_room_id: args.p_room_id,
    p_days: days, p_start: args.p_start, p_end: args.p_end, p_exclude_ids: excludeIds,
  });
  if (error || !data?.ok) return;
  const rooms = data.rooms || [];
  const times = data.times || [];
  const box = $('form-alert');
  if (!rooms.length && !times.length) {
    box.insertAdjacentHTML('beforeend', '<p><strong>No available room or alternative time was found.</strong></p>');
    return;
  }
  box.insertAdjacentHTML('beforeend', `<div class="suggestions"><strong>Suggestions</strong>
    ${rooms.length ? `<p>Available rooms for the selected time: ${rooms.map((room) => `<button type="button" data-suggest-room="${esc(room.id)}">${esc(room.name)}</button>`).join(' ')}</p>` : ''}
    ${times.length ? `<p>Available start times in the selected room: ${times.map((slot) => `<button type="button" data-suggest-time="${esc(slot.start)}">${to12h(slot.start)}</button>`).join(' ')}</p>` : ''}</div>`);
}
$('form-alert').addEventListener('click', (e) => {
  const room = e.target.closest('[data-suggest-room]');
  if (room) $('f-room').value = room.dataset.suggestRoom;
  const time = e.target.closest('[data-suggest-time]');
  if (time) { $('f-start').value = time.dataset.suggestTime.slice(0, 5); updateClassEnd(); }
});

function friendlyScheduleMessage(value) {
  const message = String(value || '').trim();
  if (!message) return 'No details were returned. Refresh the page and try again.';
  if (/^Classes cannot start before 8:00 AM/i.test(message)) return 'Classes must start at or after 8:00 AM.';
  if (/^Each class must be exactly 2 hours 30 minutes/i.test(message)) return 'Each class must last exactly 2 hours 30 minutes. The end time is calculated from the start time.';
  if (/^Faculty availability:/i.test(message)) {
    const match = message.match(/^Faculty availability:\s*(.+?) is not available for the full class on (.+?)\.?$/i);
    return match
      ? `${match[1]} is not available for the full class on ${match[2]}. Choose a time within their availability.`
      : 'The selected teacher is not available for the full class. Choose another teacher or time.';
  }
  if (/^Break required:/i.test(message)) {
    const cohort = message.match(/^Break required: this Program and Year Level needs at least 30 minutes between classes on (.+?)\.?$/i);
    if (cohort) return `This program and year group needs at least 30 minutes between classes on ${cohort[1]}. Move this class farther from the group's other class.`;
    const teacher = message.match(/^Break required:\s*(.+?) needs at least 30 minutes between classes on (.+?)\.?$/i);
    if (teacher) return `${teacher[1]} needs at least 30 minutes between classes on ${teacher[2]}. Move this class farther from their other class.`;
  }
  if (/^Break Time:/i.test(message)) {
    const match = message.match(/^Break Time: this class overlaps the (.+?) \((.+)\)\.?$/i);
    return match
      ? `This class overlaps the ${match[1]} (${match[2]}). Choose a time outside that break.`
      : 'This class overlaps a scheduled break. Choose a different time.';
  }
  if (/^Max Load:/i.test(message)) {
    const match = message.match(/^Max Load:\s*(.+?) would have (.+?) hours per week, but the limit is (.+?)\.?$/i);
    return match
      ? `${match[1]}'s weekly teaching load would be ${match[2]} hours, above the ${match[3]}-hour limit. Choose another teacher or reduce their schedule.`
      : 'The selected teacher would exceed their weekly teaching-load limit. Choose another teacher or time.';
  }
  if (/^Schedule Conflict:/i.test(message)) {
    const detail = message.replace(/^Schedule Conflict:\s*/i, '');
    if (/this time was just taken/i.test(detail)) return 'Another schedule has taken this time. Refresh the schedule list and choose a different time.';
    const times = detail.match(/ from (.+?)\s*[^A-Za-z0-9\s:]+\s*(.+?)\.?$/);
    const room = detail.match(/^(.+?) is already occupied on (.+?) from /i);
    if (room) return `Room ${room[1]} is booked on ${room[2]}${times ? ` from ${times[1]} to ${times[2]}` : ' at that time'}. Choose another room or time.`;
    const teacher = detail.match(/^(.+?) already has a class on (.+?) from /i);
    if (teacher) return `${teacher[1]} already has a class on ${teacher[2]}${times ? ` from ${times[1]} to ${times[2]}` : ' at that time'}. Choose another time or teacher.`;
    const cohort = detail.match(/^this Program and Year Level already has a class on (.+?) from /i);
    if (cohort) return `This program and year group already has a class on ${cohort[1]}${times ? ` from ${times[1]} to ${times[2]}` : ' at that time'}. Choose another time.`;
    return `A schedule conflict was found: ${detail}`;
  }
  if (/^No active scheduling period/i.test(message)) return 'There is no active scheduling period. Ask the Program Head to activate one before saving.';
  if (/^One of the selected items does not exist/i.test(message)) return 'A selected course, program, year, teacher, or room is no longer available. Refresh the page and try again.';
  if (/^Invalid day or time/i.test(message)) return 'The selected day or time is invalid. Check the schedule details and try again.';
  if (message === 'Schedule Conflict') return 'Another class may already use this room, teacher, or student group at that time. Choose a different time or resource.';
  return message;
}

function resetForm() {
  editingId = null;
  editingPairId = null;
  $('schedule-form').reset();
  if (currentSemester) $('f-semester').value = currentSemester;
  updateSemesterNote();
  if (lookups.subjects.length) updateSubjectOptions();

  $('form-title').textContent = 'Create Schedule';
  $('form-submit').textContent = 'Check Conflicts and Save as Draft';
  $('form-cancel').hidden = true;
  updateLoadNote();
  updateCombineNote();
}

function updateClassEnd() {
  const start = $('f-start').value;
  if (!start) { $('f-end').value = ''; return; }
  const end = toMin(start) + 150;
  $('f-end').value = end < 24 * 60 ? minToTime(end).slice(0, 5) : '';
}
$('f-start').addEventListener('input', updateClassEnd);
$('f-start').addEventListener('change', updateClassEnd);

/* Tells the Program Head when this slot is already a combined class, so saving it
   again adds another course to the same meeting instead of looking like a clash. */
function updateCombineNote() {
  const note = $('combine-note');
  if (!note) return;
  const teacher = $('f-teacher').value;
  const room = $('f-room').value;
  const day = $('f-day').value;
  const start = $('f-start').value;
  const end = $('f-end').value;
  if (!teacher || !room || !day || !start || !end) { note.hidden = true; note.textContent = ''; return; }
  const skip = new Set();
  if (editingId !== null) {
    if (editingPairId) staffRows.filter((row) => row.schedule_pair_id === editingPairId).forEach((row) => skip.add(String(row.id)));
    else skip.add(String(editingId));
  }
  const key = [teacher, room, day, start, end].join('|');
  const matches = staffRows.filter((row) => !skip.has(String(row.id)) && meetingKey(row) === key);
  if (!matches.length) { note.hidden = true; note.textContent = ''; return; }
  const courses = [...new Set(matches.map((row) => `${row.subject_code} (${row.program_name}, ${row.year_level})`))];
  note.hidden = false;
  const detail = `<strong>Combined class:</strong> ${esc(courses.join(', '))} ${matches.length === 1 ? 'already meets' : 'already meet'} with this teacher in this room at this time. `;
  note.innerHTML = detail + (editingId === null
    ? 'Saving adds this course to the same combined class; it is not a conflict.'
    : 'Courses in a combined class are edited one at a time; keep the same teacher, room and time to keep it combined.');
}
['f-teacher', 'f-room', 'f-day', 'f-start'].forEach((id) => {
  $(id).addEventListener('change', () => { updateCombineNote(); updateSubjectOptions(); });
});

/* Paired classes meet on Monday + Wednesday or Tuesday + Thursday, at the same time. */
function updateSecondDayOptions() {
  const partner = SECOND_DAY[$('f-day').value] || '';
  const select = $('f-day2');
  select.innerHTML = `<option value="">No second day</option>${partner ? `<option value="${partner}">${partner}</option>` : ''}`;
  select.disabled = !partner;
  select.value = '';
  updateLoadNote();
}
$('f-day').addEventListener('change', updateSecondDayOptions);
$('schedule-form').addEventListener('reset', () => setTimeout(updateSecondDayOptions));

function gapText(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '', rest ? `${rest} minutes` : '']
    .filter(Boolean).join(' ') || 'no time';
}

/* Classes of the same program and year level keep a 30–60 minute break on each day. */
function breakIssues(day, start, end) {
  const skip = new Set();
  if (editingId !== null) {
    if (editingPairId) staffRows.filter((row) => row.schedule_pair_id === editingPairId).forEach((row) => skip.add(String(row.id)));
    else skip.add(String(editingId));
  }
  const group = staffRows
    .filter((row) => row.day === day && !skip.has(String(row.id))
      && String(row.program_id) === $('f-program').value
      && String(row.year_level_id) === $('f-year').value
      // A course added to an existing combined class is the same meeting, not an overlap.
      && !(toMin(row.start_time) === start && toMin(row.end_time) === end
        && String(row.room_id) === $('f-room').value && String(row.teacher_id) === $('f-teacher').value))
    .map((row) => [toMin(row.start_time), toMin(row.end_time)]);
  const at = (minutes) => to12h(minToTime(minutes));
  if (group.some(([s, e]) => s < end && start < e)) {
    return [`This class overlaps another class for this program and year level on ${day}.`];
  }
  const issues = [];
  const previousEnd = Math.max(-Infinity, ...group.filter(([, e]) => e <= start).map(([, e]) => e));
  const nextStart = Math.min(Infinity, ...group.filter(([s]) => s >= end).map(([s]) => s));
  if (Number.isFinite(previousEnd)) {
    const gap = start - previousEnd;
    if (gap < BREAK_MIN) {
      issues.push(`The class before this one on ${day} ends at ${at(previousEnd)}. Start at ${at(previousEnd + BREAK_MIN)} or later so the break is at least 30 minutes.`);
    } else if (gap > BREAK_MAX) {
      issues.push(`Starting ${gapText(gap)} after the ${at(previousEnd)} class on ${day} leaves too much empty time. Start between ${at(previousEnd + BREAK_MIN)} and ${at(previousEnd + BREAK_MAX)}.`);
    }
  }
  if (Number.isFinite(nextStart)) {
    const gap = nextStart - end;
    if (gap < BREAK_MIN) {
      issues.push(`The next class on ${day} starts at ${at(nextStart)}. Finish at least 30 minutes before it, so start at ${at(nextStart - 150 - BREAK_MIN)} or earlier.`);
    } else if (gap > BREAK_MAX) {
      issues.push(`This time leaves ${gapText(gap)} empty before the ${at(nextStart)} class on ${day}. Start between ${at(nextStart - 150 - BREAK_MAX)} and ${at(nextStart - 150 - BREAK_MIN)}.`);
    }
  }
  return issues;
}
updateSecondDayOptions();

/* Weekly teaching load for the selected teacher, including the class being saved.
   Combined courses share one meeting, so their hours count once. */
function teacherLoadInfo() {
  const teacher = lookups.teachers.find((t) => String(t.id) === String($('f-teacher').value));
  if (!teacher) return null;
  const skip = new Set();
  if (editingId !== null) {
    if (editingPairId) staffRows.filter((row) => row.schedule_pair_id === editingPairId).forEach((row) => skip.add(String(row.id)));
    else skip.add(String(editingId));
  }
  const current = teachingHours(staffRows
    .filter((row) => !skip.has(String(row.id)) && String(row.teacher_id) === String(teacher.id)));
  const existing = new Set(staffRows.filter((row) => !skip.has(String(row.id))).map(meetingKey));
  const days = $('f-day2').value ? [$('f-day').value, $('f-day2').value] : [$('f-day').value];
  const added = days.filter(Boolean).reduce((sum, day) => {
    const key = [String(teacher.id), $('f-room').value, day, $('f-start').value, $('f-end').value].join('|');
    return sum + (existing.has(key) ? 0 : 2.5);
  }, 0);
  return { name: teacher.teacher_name, current, added, days: days.filter(Boolean).length || 1, total: current + added, max: Number(teacher.max_load_hours) };
}

function updateLoadNote() {
  const note = $('load-note');
  if (!note) return;
  const info = teacherLoadInfo();
  note.classList.remove('field-warn');
  if (!info) { note.textContent = ''; return; }
  const over = info.total > info.max + 0.001;
  note.textContent = info.added === 0
    ? `${round1(info.current)} of ${info.max} hours already scheduled; adding a course to this combined class adds no extra hours.`
    : `${round1(info.current)} of ${info.max} hours already scheduled; this ${info.days === 2 ? 'paired class adds 5' : 'class adds 2.5'} hours` + (over ? ' — over the limit.' : '.');
  if (over) note.classList.add('field-warn');
}

$('f-teacher').addEventListener('change', updateLoadNote);

function startEdit(id) {
  const s = staffRows.find((r) => r.id === id);
  if (!s) return;
  editingId = id;
  editingPairId = s.schedule_pair_id;
  $('f-program').value = s.program_id;
  $('f-year').value = s.year_level_id;
  $('f-semester').value = s.semester || currentSemester || $('f-semester').value;
  updateSemesterNote();
  updateSubjectOptions();
  $('f-subject').value = s.subject_id;
  $('f-teacher').value = s.teacher_id;
  $('f-room').value = s.room_id;
  const pairedDays = editingPairId
    ? staffRows.filter((r) => r.schedule_pair_id === editingPairId).map((r) => r.day).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
    : [];
  $('f-day').value = s.day;
  updateSecondDayOptions();
  $('f-day2').value = pairedDays.length === 2 ? (pairedDays.find((d) => d !== s.day) || '') : '';
  $('f-start').value = s.start_time.slice(0, 5);
  updateClassEnd();
  $('form-title').textContent = `Edit Schedule: ${s.subject_code}`;
  $('form-submit').textContent = 'Check Conflicts and Save Changes';
  $('form-cancel').hidden = false;
  $('form-alert').hidden = true;
  updateLoadNote();
  updateCombineNote();
  $('create-panel').scrollIntoView({ behavior: 'smooth' });
}

$('form-cancel').addEventListener('click', () => {
  resetForm();
  $('form-alert').hidden = true;
});

$('schedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('form-alert').hidden = true;
  updateClassEnd();
  if (! $('f-end').value || toMin($('f-end').value) - toMin($('f-start').value) !== 150) {
    return showFormAlert('error', 'Each class must be exactly 2 hours 30 minutes. Choose a valid start time; the end time is calculated automatically.');
  }

  const chosenSemester = $('f-semester').value;
  if (currentSemester && chosenSemester !== currentSemester) {
    return showFormAlert('error', `Only the active ${currentSemester} Semester period can receive schedules. Choose ${currentSemester} Semester here, or switch the active period under Rooms & Periods.`);
  }

  const day = $('f-day').value;
  if (!day) return showFormAlert('error', 'Choose a day for this class.');
  const secondDay = $('f-day2').value;
  const days = secondDay ? [day, secondDay] : [day];
  const load = teacherLoadInfo();
  if (load && load.total > load.max + 0.001) {
    return showFormAlert('error', `${load.name}'s weekly teaching load would be ${round1(load.total)} hours, above the ${load.max}-hour limit. Choose another teacher or reduce the schedule.`);
  }
  if (editingPairId && days.length !== 2) {
    return showFormAlert('error', 'Keep paired schedules paired. Cancel and create a new schedule to change between single and paired days.');
  }
  const startMinute = toMin($('f-start').value);
  const breakProblems = days.flatMap((d) => breakIssues(d, startMinute, startMinute + 150));
  if (breakProblems.length) {
    return showFormAlert('error', 'Adjust the break between classes:', breakProblems);
  }
  const args = {
    p_subject_id: Number($('f-subject').value),
    p_program_id: Number($('f-program').value),
    p_year_level_id: Number($('f-year').value),
    p_teacher_id: Number($('f-teacher').value),
    p_room_id: Number($('f-room').value),
    p_start: $('f-start').value,
    p_end: $('f-end').value,
  };
  const wasEditing = editingId !== null;
  let result;
  if (editingPairId || (wasEditing && days.length === 2)) {
    result = await sb.rpc('update_schedule_pair', { p_id: editingId, ...args, p_day_one: days[0], p_day_two: days[1] });
  } else if (wasEditing) {
    result = await sb.rpc('update_schedule', { p_id: editingId, ...args, p_day: days[0] });
  } else if (days.length === 2) {
    result = await sb.rpc('create_schedule_pair', { ...args, p_day_one: days[0], p_day_two: days[1] });
  } else {
    result = await sb.rpc('create_schedule', { ...args, p_day: days[0] });
  }
  const { data, error } = result;

  if (error) {
    console.error('Schedule save failed:', error);
    showFormAlert('error', 'The schedule was not saved. Reason:', [friendlyScheduleMessage(error.message)]);
    await showConflictSuggestions(args, days);
  } else if (data.ok) {
    resetForm();
    showFormAlert('ok', wasEditing ? 'Changes saved.' : 'Saved as draft.');
    loadSchedules();
  } else if (data.conflicts) {
    showFormAlert('error', 'The schedule was not saved. Fix the following:', data.conflicts.map(friendlyScheduleMessage));
    await showConflictSuggestions(args, days);
  } else {
    showFormAlert('error', 'The schedule was not saved. Reason:', [friendlyScheduleMessage(data.error)]);
  }
});

/* ---------- reports (Program Head) ---------- */

$('app-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) showTab(btn.dataset.tab);
});
$('app-tabs').addEventListener('keydown', (e) => {
  const tabs = [...$('app-tabs').querySelectorAll('[data-tab]')].filter((tab) => !tab.hidden);
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  const next = e.key === 'Home' ? tabs[0]
    : e.key === 'End' ? tabs[tabs.length - 1]
      : step ? tabs[(index + step + tabs.length) % tabs.length] : null;
  if (!next) return;
  e.preventDefault();
  next.focus();
  showTab(next.dataset.tab);
});
['r-type', 'r-program', 'r-year', 'r-teacher', 'r-room'].forEach((id) =>
  $(id).addEventListener('change', renderReport));
$('r-print').addEventListener('click', () => window.print());

const COLS = {
  subject: ['Subject', (s) => subjectCell(s)],
  group: ['Program and year', (s) => `${esc(s.program_name)}, ${esc(s.year_level)}`],
  teacher: ['Teacher', (s) => esc(s.teacher_name)],
  room: ['Room', (s) => esc(s.room_name)],
  day: ['Day', (s) => esc(s.day)],
  time: ['Time', (s) => `${to12h(s.start_time)} — ${to12h(s.end_time)}`],
  status: ['Status', (s) => `<span class="badge ${esc(s.status)}">${esc(s.status)}</span>`],
};

function scheduleTable(rows, keys) {
  if (rows.length === 0) return '<p class="muted">No classes scheduled for this selection.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr>${keys.map((k) => `<th>${COLS[k][0]}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((s) => `<tr>${keys.map((k) => `<td>${COLS[k][1](s)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// Free time between DAY_START and DAY_END, given a room's occupied slots
function freeSlots(roomRows) {
  const busy = roomRows.map((s) => [toMin(s.start_time), toMin(s.end_time)]).sort((a, b) => a[0] - b[0]);
  const free = [];
  let cursor = DAY_START;
  for (const [start, end] of busy) {
    if (start > cursor) free.push([cursor, Math.min(start, DAY_END)]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < DAY_END) free.push([cursor, DAY_END]);
  return free.filter(([a, b]) => b > a);
}

const slotText = ([a, b]) => `${to12h(minToTime(a))} — ${to12h(minToTime(b))}`;

function availabilityText(teacherId) {
  return lookups.availability.filter((a) => String(a.teacher_id) === String(teacherId))
    .sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day))
    .map((a) => `${a.day.slice(0, 3)} ${to12h(a.start_time)}—${to12h(a.end_time)}`).join('; ') || 'Not configured';
}
function renderReport() {
  if (!currentUser) return;
  const admin = isAdmin();
  // Only the Program Head sees every faculty member's load; teachers get their own.
  $('r-type').querySelector('option[value="faculty-all"]').hidden = !admin;
  if (!admin && $('r-type').value === 'faculty-all') $('r-type').value = 'faculty';
  if (!admin && currentUser.teacher_id) $('r-teacher').value = currentUser.teacher_id;
  const type = $('r-type').value;
  $('r-program-wrap').hidden = type !== 'class';
  $('r-year-wrap').hidden = type !== 'class';
  $('r-teacher-wrap').hidden = type !== 'faculty';
  $('r-room-wrap').hidden = !(type === 'room' || type === 'availability');

  const out = $('report-output');
  reportScheduleRows = [];
  reportTitle = 'Schedule report';
  $('r-export-alert').hidden = true;
  const meta = `<p class="muted report-meta">${esc($('period-label').textContent)} — Generated ${esc(new Date().toLocaleDateString())}</p>`;
  const pick = (id, list, key) => list.find((x) => String(x.id) === $(id).value);

  if (type === 'class') {
    const program = pick('r-program', lookups.programs);
    const year = pick('r-year', lookups.years);
    if (!program || !year) { out.innerHTML = ''; return; }
    const rows = staffRows.filter((s) => String(s.program_id) === String(program.id) && String(s.year_level_id) === String(year.id));
    reportTitle = `Class schedule: ${program.program_name}, ${year.year_level}`; reportScheduleRows = rows;
    out.innerHTML = `<h3>Class schedule: ${esc(program.program_name)}, ${esc(year.year_level)}</h3>${meta}` +
      scheduleTable(rows, ['subject', 'teacher', 'room', 'day', 'time', 'status']);
  } else if (type === 'faculty-all') {
    reportTitle = 'All faculty summary'; reportScheduleRows = staffRows;
    const rows = lookups.teachers.map((teacher) => {
      const classes = staffRows.filter((s) => String(s.teacher_id) === String(teacher.id));
      const load = teachingHours(classes);
      return `<tr><td>${esc(teacher.teacher_name)}</td><td>${classes.length}</td>
        <td>${round1(load)} / ${esc(teacher.max_load_hours)} hours</td><td>${esc(availabilityText(teacher.id))}</td></tr>`;
    }).join('');
    out.innerHTML = `<h3>All faculty summary</h3>${meta}<div class="table-wrap"><table>
      <thead><tr><th>Faculty</th><th>Classes</th><th>Weekly load / limit</th><th>Availability</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  } else if (type === 'faculty') {
    const teacher = pick('r-teacher', lookups.teachers);
    if (!teacher) { out.innerHTML = ''; return; }
    const rows = staffRows.filter((s) => String(s.teacher_id) === String(teacher.id));
    reportTitle = `Faculty schedule: ${teacher.teacher_name}`; reportScheduleRows = rows;
    const total = teachingHours(rows);
    out.innerHTML = `<h3>Faculty schedule: ${esc(teacher.teacher_name)}</h3>${meta}` +
      `<p><strong>Teaching load:</strong> ${round1(total)} of ${esc(teacher.max_load_hours)} hours per week</p>` +
      `<p><strong>Availability:</strong> ${esc(availabilityText(teacher.id))}</p>` +
      scheduleTable(rows, ['subject', 'group', 'room', 'day', 'time', 'status']);
  } else if (type === 'room') {
    const room = pick('r-room', lookups.rooms);
    if (!room) { out.innerHTML = ''; return; }
    const rows = staffRows.filter((s) => String(s.room_id) === String(room.id));
    reportTitle = `Room schedule: ${room.room_name}`; reportScheduleRows = rows;
    out.innerHTML = `<h3>Room schedule: ${esc(room.room_name)}</h3>${meta}` +
      scheduleTable(rows, ['subject', 'group', 'teacher', 'day', 'time', 'status']);
  } else {
    const room = pick('r-room', lookups.rooms);
    if (!room) { out.innerHTML = ''; return; }
    if (room.is_online) {
      out.innerHTML = `<h3>Room availability: ${esc(room.room_name)}</h3>${meta}` +
        '<p class="alert ok">Online classes do not use a physical room, so this room is always available.</p>';
      return;
    }
    const roomRows = staffRows.filter((s) => String(s.room_id) === String(room.id));
    reportTitle = `Room availability: ${room.room_name}`; reportScheduleRows = roomRows;
    const body = DAY_ORDER.map((day) => {
      const dayRows = sortSchedules(roomRows.filter((s) => s.day === day));
      const occupied = meetingGroups(dayRows)
        .map((group) => `${to12h(group.rows[0].start_time)} — ${to12h(group.rows[0].end_time)} (${group.rows.map((s) => esc(s.subject_code)).join(' + ')})`)
        .join('<br>') || '<span class="muted">None</span>';
      const free = freeSlots(dayRows).map(slotText).join('<br>') || '<span class="muted">Fully booked</span>';
      return `<tr><td>${day}</td><td>${occupied}</td><td>${free}</td></tr>`;
    }).join('');
    out.innerHTML = `<h3>Room availability: ${esc(room.room_name)}</h3>${meta}
      <p class="muted">Free time is shown between ${slotText([DAY_START, DAY_END])}. Draft and published classes both count as occupied.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Day</th><th>Occupied</th><th>Free</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>`;
  }
}

function renderWeeklyGrid(rows, targetId) {
  const grid = $(targetId);
  if (!grid) return;
  const days = DAY_ORDER;
  const gridStart = 8 * 60;
  const timeRows = Array.from({ length: 24 }, (_, i) => {
    const minute = gridStart + i * 30;
    const label = to12h(minToTime(minute));
    return `<div class="weekly-time" style="grid-column:1;grid-row:${i + 2}">${label}</div>` +
      days.map((_, d) => `<div class="weekly-slot" style="grid-column:${d + 2};grid-row:${i + 2}" aria-hidden="true"></div>`).join('');
  }).join('');
  const cards = meetingGroups(rows).map((group) => {
    const s = group.rows[0];
    const day = days.indexOf(s.day);
    const start = toMin(s.start_time);
    const span = Math.ceil((toMin(s.end_time) - start) / 30);
    const row = Math.floor((start - gridStart) / 30) + 2;
    if (day < 0 || row < 2 || row + span > 26) return '';
    const codes = group.rows.map((r) => r.subject_code).join(' + ');
    const names = group.rows.map((r) => r.subject_name).join(' / ');
    const programs = [...new Set(group.rows.map((r) => `${r.program_name || ''}${r.year_level ? `, ${r.year_level}` : ''}`))].filter(Boolean).join(' · ');
    return `<article class="weekly-class" style="grid-column:${day + 2};grid-row:${row}/span ${span}" title="${esc(codes)} ${esc(s.start_time)}–${esc(s.end_time)}">
      <strong>${esc(codes)} – ${esc(names)}</strong><span>${to12h(s.start_time)}–${to12h(s.end_time)}</span>
      <span>${esc(programs)}</span>
      <span>${esc(s.teacher_name || '')}</span><span>${esc(s.room_name || '')}</span>
      ${group.rows.length > 1 ? '<span>Combined class</span>' : ''}</article>`;
  }).join('');
  grid.innerHTML = rows.length
    ? `<div class="weekly-grid" role="grid" aria-label="Weekly timetable" style="grid-template-columns:64px repeat(6,minmax(140px,1fr));grid-template-rows:2.4rem repeat(24,2.1rem)">
        <div class="weekly-day" style="grid-column:1;grid-row:1">Time</div>${days.map((d,i)=>`<div class="weekly-day" style="grid-column:${i+2};grid-row:1">${d}</div>`).join('')}${timeRows}${cards}</div>`
    : '<p class="muted">No classes to show in the weekly timetable.</p>';
}

const csvCell = (value) => {
  const text = String(value ?? '');
  const safe = /^[=+@\-\t\r]/.test(text.trimStart()) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};
function downloadCsv(headers, rows, filename) {
  const content = '\ufeff' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(content, 'text/csv;charset=utf-8', `${filename}.csv`);
}
function downloadBlob(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function scheduleMatrix(rows) {
  const headers = ['Course code','Course','Program','Year','Teacher','Room','Day','Start','End','Status','Combined with'];
  return [headers, rows.map((s) => [s.subject_code, s.subject_name, s.program_name, s.year_level,
    s.teacher_name, s.room_name, s.day, to12h(s.start_time), to12h(s.end_time), s.status || 'Published',
    (s.combined_with || []).join(', ')])];
}
function downloadScheduleCsv(rows, filename) {
  const [headers, data] = scheduleMatrix(rows);
  downloadCsv(headers, data, filename);
}
function downloadPdf(headers, rows, title, filename) {
  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) return alert('PDF export could not load. Check your internet connection and retry.');
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setProperties({ title });
  let y = 15;
  const pageWidth = doc.internal.pageSize.getWidth() - 24;
  const write = (text, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    const lines = doc.splitTextToSize(String(text ?? ''), pageWidth);
    for (const line of lines) {
      if (y > 195) { doc.addPage(); y = 15; }
      doc.text(line, 12, y); y += 5;
    }
  };
  doc.setFontSize(15); write(title, true); doc.setFontSize(8);
  write(headers.join(' | '), true);
  rows.forEach((row) => { write(row.join(' | ')); y += 1; });
  doc.save(`${filename}.pdf`);
}
function downloadSchedulePdf(rows, title) {
  const [headers, data] = scheduleMatrix(rows);
  downloadPdf(headers, data, title, title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

/* A printable weekly grid: days across, time down, one block per class. */
function downloadTimetablePdf(rows, title) {
  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) return alert('PDF export could not load. Check your internet connection and retry.');
  if (!rows.length) return alert('There are no classes to put on the timetable.');
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 10;
  const days = DAY_ORDER;
  const startMin = Math.floor(Math.min(...rows.map((r) => toMin(r.start_time))) / 60) * 60;
  const endMin = Math.ceil(Math.max(...rows.map((r) => toMin(r.end_time))) / 60) * 60;
  const labelW = 20;
  const colW = (W - 2 * M - labelW) / days.length;
  let y = 14;

  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(7, 61, 39);
  doc.text('Unida Christian Colleges · ScholarSched', M, y);
  y += 6;
  doc.setFontSize(12).text(title, M, y);
  y += 5;
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(86, 100, 92);
  const periodLabel = $('student-view').hidden ? $('period-label')?.textContent : $('student-period')?.textContent;
  doc.text([periodLabel, `Generated ${new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}`]
    .filter(Boolean).join('   |   '), M, y);
  y += 5;

  const headerH = 6;
  const slotH = 5;
  const rowCount = Math.max(1, (endMin - startMin) / 30);
  doc.setFillColor(7, 61, 39).rect(M, y, W - 2 * M, headerH, 'F');
  doc.setTextColor(255).setFont('helvetica', 'bold').setFontSize(8);
  doc.text('Time', M + 1.5, y + 4);
  days.forEach((day, i) => doc.text(day, M + labelW + i * colW + 1.5, y + 4));
  y += headerH;
  const top = y;
  const bottom = top + rowCount * slotH;

  doc.setDrawColor(214, 219, 210).setTextColor(86, 100, 92).setFont('helvetica', 'normal').setFontSize(6.5);
  for (let i = 0; i <= rowCount; i += 1) {
    const lineY = top + i * slotH;
    doc.line(M, lineY, W - M, lineY);
    if (i < rowCount && i % 2 === 0) doc.text(to12h(minToTime(startMin + i * 30)), M + 1.5, lineY + 3.5);
  }
  doc.line(M + labelW, top, M + labelW, bottom);
  days.forEach((_, i) => doc.line(M + labelW + i * colW, top, M + labelW + i * colW, bottom));
  doc.line(W - M, top, W - M, bottom);

  days.forEach((day, dayIndex) => {
    const classes = meetingGroups(rows.filter((r) => r.day === day))
      .map((group) => ({
        ...group.rows[0],
        subject_code: group.rows.map((r) => r.subject_code).join(' + '),
      }))
      .sort((a, b) => toMin(a.start_time) - toMin(b.start_time));
    if (!classes.length) return;
    // Share a day column between classes that overlap in time.
    const lanes = [];
    const placed = classes.map((row) => {
      let lane = lanes.findIndex((end) => end <= toMin(row.start_time));
      if (lane < 0) { lanes.push(0); lane = lanes.length - 1; }
      lanes[lane] = toMin(row.end_time);
      return { row, lane };
    });
    const laneW = (colW - 2) / lanes.length;
    placed.forEach(({ row, lane }) => {
      const blockTop = top + ((toMin(row.start_time) - startMin) / 30) * slotH + 0.8;
      const blockH = Math.min(bottom - blockTop - 0.8, ((toMin(row.end_time) - toMin(row.start_time)) / 30) * slotH - 1.6);
      if (blockH <= 2) return;
      const x = M + labelW + dayIndex * colW + 1 + lane * laneW;
      doc.setFillColor(232, 241, 235).setDrawColor(11, 90, 54);
      doc.rect(x, blockTop, laneW - 0.8, blockH, 'FD');
      doc.setTextColor(7, 61, 39).setFont('helvetica', 'bold').setFontSize(6.5);
      doc.text(doc.splitTextToSize(row.subject_code, laneW - 3).slice(0, 2), x + 1.2, blockTop + 3);
      doc.setFont('helvetica', 'normal').setFontSize(5.5);
      doc.text(doc.splitTextToSize(`${row.room_name || ''} · ${to12h(row.start_time)}`, laneW - 3).slice(0, 2), x + 1.2, blockTop + blockH - 2.4);
    });
  });

  doc.save(`scholarsched-timetable-${new Date().toISOString().slice(0, 10)}.pdf`);
}

/* ---------- user management (Program Head) ---------- */

async function loadUsers() {
  if (!$('user-body') || !currentUser || currentUser.role !== 'admin') return;
  const columns = `user_id, name, role, teacher_id${caps.userEmails ? ', email' : ''}`;
  const { data, error } = await sb.from('profiles').select(columns).order('name');
  if (error) {
    $('user-body').innerHTML = '<tr><td colspan="5" class="muted">Could not load the accounts.</td></tr>';
    return;
  }
  currentUsers = data || [];
  renderUsers();
}

function renderUsers() {
  if (!$('user-body')) return;
  const teacherById = new Map(lookups.teachers.map((t) => [String(t.id), t.teacher_name]));
  $('user-email-note').hidden = caps.userEmails;
  $('user-body').innerHTML = currentUsers.map((u) => `
    <tr><td>${esc(u.name)}${u.user_id === currentUser.id ? ' <span class="badge PUBLISHED">You</span>' : ''}</td>
      <td>${esc(u.email || '—')}</td>
      <td>${esc(roleLabel(u.role))}</td>
      <td>${esc(teacherById.get(String(u.teacher_id)) || '—')}</td>
      <td><button type="button" data-edit-user="${esc(u.user_id)}">Edit</button>
      <button type="button" class="danger" data-remove-user="${esc(u.user_id)}" ${u.user_id === currentUser.id ? 'disabled title="You cannot remove your own account"' : ''}>Remove</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">No accounts yet.</td></tr>';
}

function userTeacherField() {
  const admin = $('user-role').value === 'admin';
  $('user-teacher-wrap').hidden = admin;
  $('user-teacher').value = admin ? '' : $('user-teacher').value;
}
$('user-role').addEventListener('change', userTeacherField);

$('user-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-user]');
  if (edit) {
    const user = currentUsers.find((u) => u.user_id === edit.dataset.editUser);
    if (!user) return;
    $('user-id').value = user.user_id;
    $('user-name').value = user.name;
    $('user-email').value = user.email || '';
    $('user-password').value = '';
    $('user-email').disabled = !caps.userEmails;
    $('user-password').disabled = true;
    $('user-role').value = user.role;
    $('user-teacher').value = user.teacher_id ?? '';
    userTeacherField();
    $('user-submit').textContent = 'Save Account';
    $('user-cancel').hidden = false;
    $('user-alert').hidden = true;
    return;
  }
  const remove = e.target.closest('[data-remove-user]');
  if (!remove || remove.disabled) return;
  const user = currentUsers.find((u) => u.user_id === remove.dataset.removeUser);
  if (!user || !confirm(`Remove ${user.name}'s access? Their Supabase login stays, but it will no longer have a role.`)) return;
  const { error } = await sb.from('profiles').delete().eq('user_id', user.user_id);
  if (error) return showCurriculumAlert('user-alert', 'error', 'Could not remove the account access.');
  showCurriculumAlert('user-alert', 'ok', `${user.name} no longer has access.`);
  await loadUsers();
});

$('user-cancel').addEventListener('click', () => {
  $('user-form').reset();
  $('user-id').value = '';
  $('user-email').disabled = false;
  $('user-password').disabled = false;
  $('user-submit').textContent = 'Add Account';
  $('user-cancel').hidden = true;
  $('user-alert').hidden = true;
  $('user-teacher-wrap').hidden = false;
});

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('user-id').value;
  const role = $('user-role').value;
  const values = {
    name: $('user-name').value.trim(),
    role,
    teacher_id: role === 'teacher' && $('user-teacher').value ? Number($('user-teacher').value) : null,
  };
  const btn = $('user-submit');
  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    const email = $('user-email').value.trim().toLowerCase();
    if (id) {
      if (caps.userEmails) {
        const { data, error } = await sb.rpc('admin_update_staff_email', { p_user_id: id, p_email: email });
        if (error || !data?.ok) {
          return showCurriculumAlert('user-alert', 'error', error?.message || data?.error || 'Could not update the email address.');
        }
        values.email = email;
      }
      const { error } = await sb.from('profiles').update(values).eq('user_id', id);
      if (error) return showCurriculumAlert('user-alert', 'error', 'Could not save the account.');
      $('user-cancel').click();
      showCurriculumAlert('user-alert', 'ok', 'Account updated.' + (caps.userEmails ? ' They can sign in with the new email address.' : ''));
      await loadUsers();
      return;
    }
    const password = $('user-password').value;
    if (password.length < 6) return showCurriculumAlert('user-alert', 'error', 'Use a password with at least 6 characters.');

    // The SQL helper creates an already-confirmed login, so a new account can sign
    // in straight away even when Supabase email confirmations are switched on.
    if (caps.userEmails) {
      const { data, error } = await sb.rpc('admin_create_staff', {
        p_name: values.name, p_email: email, p_password: password,
        p_role: role, p_teacher_id: values.teacher_id,
      });
      if (error) {
        return showCurriculumAlert('user-alert', 'error', /does not exist|schema cache/i.test(error.message)
          ? 'Run supabase/migration_v11.sql to create accounts from here, then reload.'
          : `The account was not created. ${error.message}`);
      }
      if (!data?.ok) return showCurriculumAlert('user-alert', 'error', data?.error || 'The account was not created.');
      $('user-cancel').click();
      showCurriculumAlert('user-alert', 'ok', `Account created for ${values.name}. They can sign in now with ${email} and that password.`);
      await loadUsers();
      return;
    }

    const { data, error } = await inviteClient.auth.signUp({ email, password, options: { data: { name: values.name } } });
    if (error) {
      return showCurriculumAlert('user-alert', 'error', /already|registered|exists/i.test(error.message)
        ? 'An account already exists for that email.'
        : `The account was not created. ${error.message}`);
    }
    if (!data?.user) return showCurriculumAlert('user-alert', 'error', 'The account was not created. Check the email address and try again.');
    if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return showCurriculumAlert('user-alert', 'error', 'An account already exists for that email.');
    }
    const profile = await sb.from('profiles').insert({ user_id: data.user.id, ...values });
    if (profile.error) {
      return showCurriculumAlert('user-alert', 'error', 'The login was created, but its role could not be saved. Add it again here with the same email to finish setup.');
    }
    $('user-cancel').click();
    showCurriculumAlert('user-alert', 'ok', `Account created for ${values.name}. If email confirmation is switched on in Supabase, they must confirm the email before logging in.`);
    await loadUsers();
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
});

/* ---------- backup and restore ---------- */

const BACKUP_TABLES = [
  { name: 'departments', optional: 'departments' },
  { name: 'programs' },
  { name: 'year_levels' },
  { name: 'subjects' },
  { name: 'teachers' },
  { name: 'teacher_availability', conflict: 'teacher_id,day' },
  { name: 'rooms' },
  { name: 'curriculum_courses' },
  { name: 'scheduling_periods' },
  { name: 'schedules' },
  { name: 'profiles', conflict: 'user_id' },
];
const restoreConflict = (entry) => entry.conflict || 'id';

$('backup-download').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('is-busy');
  const errors = [];
  const tables = {};
  try {
    for (const entry of BACKUP_TABLES) {
      if (entry.optional && !caps[entry.optional]) continue;
      const { data, error } = await sb.from(entry.name).select('*');
      if (error) { errors.push(`${entry.name}: ${error.message}`); continue; }
      tables[entry.name] = data || [];
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
  if (!Object.keys(tables).length) {
    return showCurriculumAlert('backup-alert', 'error', 'The backup could not read any data.');
  }
  const payload = { app: 'ScholarSched', version: 7, generated_at: new Date().toISOString(), tables };
  downloadBlob(JSON.stringify(payload, null, 2), 'application/json', `scholarsched-backup-${new Date().toISOString().slice(0, 10)}.json`);
  const counts = BACKUP_TABLES.filter((t) => tables[t.name]).map((t) => `${t.name}: ${tables[t.name].length}`).join(', ');
  showCurriculumAlert('backup-alert', errors.length ? 'warn' : 'ok', `${errors.length ? 'Backup saved with some tables missing.' : 'Backup downloaded.'} ${counts}`);
  $('backup-summary').innerHTML = errors.length ? `<ul>${errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
});

$('backup-restore').addEventListener('click', async (e) => {
  const file = $('backup-file').files?.[0];
  if (!file) return showCurriculumAlert('backup-alert', 'error', 'Choose a backup file first.');
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (_) {
    return showCurriculumAlert('backup-alert', 'error', 'That file is not valid JSON.');
  }
  if (payload?.app !== 'ScholarSched' || !payload.tables) {
    return showCurriculumAlert('backup-alert', 'error', 'That file is not a ScholarSched backup.');
  }
  if (!confirm('Restore this backup? Records with the same id are overwritten.')) return;

  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('is-busy');
  const report = [];
  const failures = [];
  try {
    for (const entry of BACKUP_TABLES) {
      if (entry.optional && !caps[entry.optional]) { report.push(`${entry.name}: skipped (database needs migration v7)`); continue; }
      const rows = payload.tables[entry.name];
      if (!Array.isArray(rows) || !rows.length) continue;
      let body = rows;
      if (entry.name === 'curriculum_courses') {
        // Backups written before v11 carried a curriculum year that no longer exists.
        body = body.map(({ valid_years, ...rest }) => rest);
      }
      if (entry.name === 'profiles' && !caps.userEmails) {
        body = body.map(({ email, ...rest }) => rest);
      }
      if (entry.name === 'schedules') {
        body = rows.filter((row) => currentPeriod && String(row.period_id) === String(currentPeriod.id));
        if (body.length < rows.length) report.push(`schedules: ${rows.length - body.length} rows from other periods skipped`);
        if (!body.length) continue;
      }
      const { error } = await sb.from(entry.name).upsert(body, { onConflict: restoreConflict(entry) });
      if (error) failures.push(`${entry.name}: ${error.message}`);
      else report.push(`${entry.name}: ${body.length} restored`);
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }

  const seq = await sb.rpc('sync_identity_sequences');
  if (seq.error) report.push('Sequence reset unavailable. Run supabase/migration_v7.sql before adding new records.');
  $('backup-summary').innerHTML = `<ul>${report.concat(failures).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  showCurriculumAlert('backup-alert', failures.length ? 'warn' : 'ok', failures.length
    ? `Restore finished with ${failures.length} problem${failures.length === 1 ? '' : 's'}.`
    : 'Restore finished.');
  $('backup-file').value = '';
  await loadLookups();
  await loadSchedules();
  await loadUsers();
});
function icsEscape(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\r\n|\n|\r/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}
function localClassUtc(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.slice(0, 5).split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}
const icsStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function downloadScheduleIcs(rows, filename, alertId) {
  const box = $(alertId);
  box.hidden = true;
  if (!currentPeriod?.starts_on || !currentPeriod?.ends_on) {
    return showSetupAlert(alertId, 'error', 'Set start and end dates for the active scheduling period under Rooms & periods before exporting calendar events.');
  }
  if (!rows.length) return showSetupAlert(alertId, 'error', 'There are no schedules to export.');
  const until = icsStamp(localClassUtc(currentPeriod.ends_on, '23:59'));
  const events = meetingGroups(rows).map((group) => {
    const s = group.rows[0];
    const codes = group.rows.map((r) => r.subject_code).join(' + ');
    const names = group.rows.map((r) => r.subject_name).join(' / ');
    const cohorts = [...new Set(group.rows.map((r) => `${r.program_name || ''} ${r.year_level || ''}`.trim()))].join('; ');
    const day = DAY_ORDER.indexOf(s.day);
    if (day < 0) return '';
    const [year, month, date] = currentPeriod.starts_on.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - 1, date));
    const delta = (day + 1 - first.getUTCDay() + 7) % 7;
    first.setUTCDate(first.getUTCDate() + delta);
    const localDate = first.toISOString().slice(0, 10);
    if (localDate > currentPeriod.ends_on) return '';
    const start = icsStamp(localClassUtc(localDate, s.start_time));
    const end = icsStamp(localClassUtc(localDate, s.end_time));
    return ['BEGIN:VEVENT', `UID:${s.id}-${currentPeriod.id}@scholarsched`, `DTSTAMP:${icsStamp(new Date())}`,
      `DTSTART:${start}`, `DTEND:${end}`, `RRULE:FREQ=WEEKLY;UNTIL=${until}`,
      `SUMMARY:${icsEscape(`${codes} ${names}`)}`,
      `DESCRIPTION:${icsEscape(`${cohorts} | ${s.teacher_name || ''}`)}`,
      `LOCATION:${icsEscape(s.room_name)}`, 'END:VEVENT'].join('\r\n');
  }).filter(Boolean);
  if (!events.length) return showSetupAlert(alertId, 'error', 'No schedule falls within the active period dates.');
  downloadBlob(['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ScholarSched//Class Schedule//EN','CALSCALE:GREGORIAN', ...events,'END:VCALENDAR'].join('\r\n'), 'text/calendar;charset=utf-8', `${filename}.ics`);
}
function exportRenderedReportCsv() {
  const table = $('report-output').querySelector('table');
  if (!table) return alert('The selected report has no table to export.');
  const headers = [...table.querySelectorAll('thead th')].map((cell) => cell.innerText.trim());
  const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((cell) => cell.innerText.trim()));
  downloadCsv(headers, rows, reportTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}
function exportRenderedReportPdf() {
  const table = $('report-output').querySelector('table');
  if (!table) return alert('The selected report has no table to export.');
  const headers = [...table.querySelectorAll('thead th')].map((cell) => cell.innerText.trim());
  const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((cell) => cell.innerText.trim()));
  downloadPdf(headers, rows, reportTitle, reportTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}
$('r-export-csv').addEventListener('click', exportRenderedReportCsv);
$('r-export-pdf').addEventListener('click', exportRenderedReportPdf);
$('r-export-ics').addEventListener('click', () => downloadScheduleIcs(reportScheduleRows, 'report-schedule', 'r-export-alert'));

/* ---------- student view (no login) ---------- */

async function showStudent() {
  currentUser = null;
  $('app-view').hidden = true;
  $('login-view').hidden = true;
  $('student-view').hidden = false;

  const [period, programs, years, periods] = await Promise.all([
    sb.from('scheduling_periods').select('id, academic_year, semester, starts_on, ends_on').eq('is_active', true).maybeSingle(),
    sb.from('programs').select('id, program_name').order('program_name'),
    sb.from('year_levels').select('id, year_level').order('id'),
    sb.from('scheduling_periods').select('academic_year, semester').order('academic_year', { ascending: false }),
  ]);

  currentPeriod = period.data || null;
  activeYear = period.data?.academic_year || null;
  $('student-period').textContent = SCHOOL_YEAR_LABEL;

  // Offer every semester saved for this academic year, so a visitor can compare
  // 1st and 2nd Semester without waiting for that semester to become active.
  const yearSemesters = [...new Set((periods.data || [])
    .filter((p) => p.academic_year === SCHOOL_YEAR_LABEL)
    .map((p) => p.semester))].sort();
  const semesters = yearSemesters.length ? yearSemesters : ['1st', '2nd'];
  $('s-semester').innerHTML = semesters
    .map((s) => `<option value="${esc(s)}">${esc(s)} Semester</option>`).join('');
  $('s-semester').disabled = false;

  const withPlaceholder = (label, rows, labelKey) =>
    `<option value="">${label}</option>` +
    (rows || []).map((r) => `<option value="${esc(r.id)}">${esc(r[labelKey])}</option>`).join('');

  $('s-program').innerHTML = withPlaceholder('Select program', programs.data, 'program_name');
  $('s-year').innerHTML = withPlaceholder('Select year level', years.data, 'year_level');

  // Remember the last choice on this device (convenience only)
  const activeSemester = period.data?.semester || semesters[0];
  // Until the public view can filter by semester, always start on the active one.
  const pickSemester = (value) => (!caps.semesterViews
    ? activeSemester
    : (semesters.includes(value) ? value : activeSemester));
  try {
    const saved = JSON.parse(localStorage.getItem('scholarsched_student') || '{}');
    if (saved.program) $('s-program').value = saved.program;
    if (saved.year) $('s-year').value = saved.year;
    $('s-semester').value = pickSemester(saved.semester);
  } catch (_) {
    $('s-semester').value = pickSemester(period.data?.semester);
  }

  loadStudentSchedule();
}

async function loadStudentSchedule() {
  const program = $('s-program').value;
  const year = $('s-year').value;
  const semester = $('s-semester').value;
  $('student-table-view').hidden = studentView !== 'table';
  $('student-weekly-view').hidden = studentView !== 'week';
  $('s-table-view').setAttribute('aria-pressed', String(studentView === 'table'));
  $('s-week-view').setAttribute('aria-pressed', String(studentView === 'week'));
  // Remove characters that have a special meaning in the search filter
  const term = $('s-search').value.replace(/[%,()*\\]/g, ' ').trim();
  const body = $('student-body');
  const empty = $('student-empty');

  try {
    localStorage.setItem('scholarsched_student', JSON.stringify({ program, year, semester }));
  } catch (_) { /* storage unavailable */ }

  $('student-period').textContent = [SCHOOL_YEAR_LABEL, semester && `${semester} Semester`]
    .filter(Boolean).join(' · ');

  // On a database without migration v7 the public view only returns the active
  // period, so say so instead of showing that period's classes under the wrong label.
  if (!caps.semesterViews && currentPeriod && semester && semester !== currentPeriod.semester) {
    body.innerHTML = ''; studentRows = []; $('student-weekly-view').innerHTML = '';
    empty.hidden = false;
    empty.textContent = `${semester} Semester is not available in the public view yet. Only ${currentPeriod.semester} Semester can be shown until the Program Head applies the semester database update.`;
    return;
  }

  let query = sb.from('student_schedule').select('*');
  if (caps.semesterViews) {
    query = query.eq('academic_year', SCHOOL_YEAR_LABEL);
    if (semester) query = query.eq('semester', semester);
  }
  if (term.length >= 2) {
    query = query.or(`subject_code.ilike.%${term}%,subject_name.ilike.%${term}%`);
  } else if (program && year) {
    query = query.eq('program_id', Number(program)).eq('year_level_id', Number(year));
  } else {
    body.innerHTML = ''; studentRows = [];
    $('student-weekly-view').innerHTML = '';
    empty.textContent = 'Choose your program and year level, or search for a subject.';
    empty.hidden = false;
    return;
  }

  $('student-table-view').classList.add('is-loading');
  const { data, error } = await query;
  $('student-table-view').classList.remove('is-loading');
  if (error) {
    body.innerHTML = ''; studentRows = []; $('student-weekly-view').innerHTML = '';
    empty.textContent = 'Could not load the schedule.';
    empty.hidden = false;
    return;
  }

  sortSchedules(annotateCombined(data));
  studentRows = data;
  body.innerHTML = meetingGroups(data).map((group) => {
    const s = group.rows[0];
    const programs = [...new Set(group.rows.map((row) => `${row.program_name}, ${row.year_level}`))];
    return `<tr>
      <td data-label="Subject">${group.rows.map(subjectCell).join('<br>')}${group.rows.length > 1 ? '<span class="combined-note">Combined class</span>' : ''}</td>
      <td data-label="Program and year">${programs.map(esc).join('<br>')}</td>
      <td data-label="Teacher">${esc(s.teacher_name)}</td>
      <td data-label="Room">${esc(s.room_name)}</td>
      <td data-label="Day">${esc(s.day)}</td>
      <td data-label="Time">${to12h(s.start_time)} — ${to12h(s.end_time)}</td>
    </tr>`;
  }).join('');

  empty.hidden = data.length > 0;
  $('student-table-view').hidden = studentView !== 'table';
  $('student-weekly-view').hidden = studentView !== 'week';
  renderWeeklyGrid(data, 'student-weekly-view');
  empty.textContent = term.length >= 2
    ? `No published class matches "${term}".`
    : 'No published schedule for this program and year level yet.';
}

$('s-table-view').addEventListener('click', () => { studentView = 'table'; loadStudentSchedule(); });
$('s-week-view').addEventListener('click', () => { studentView = 'week'; loadStudentSchedule(); });
$('staff-list-toggle').addEventListener('click', () => { staffView = 'table'; $('staff-list-toggle').setAttribute('aria-pressed', 'true'); $('staff-weekly-toggle').setAttribute('aria-pressed', 'false'); renderStaffTable(); });
$('staff-weekly-toggle').addEventListener('click', () => { staffView = 'week'; $('staff-list-toggle').setAttribute('aria-pressed', 'false'); $('staff-weekly-toggle').setAttribute('aria-pressed', 'true'); renderStaffTable(); });
$('s-export-csv').addEventListener('click', () => downloadScheduleCsv(studentRows, 'student-schedule'));
$('s-export-ics').addEventListener('click', () => downloadScheduleIcs(studentRows, 'student-schedule', 'student-export-alert'));
$('s-export-pdf').addEventListener('click', () => downloadSchedulePdf(studentRows, 'Student schedule'));
$('s-export-timetable').addEventListener('click', () => downloadTimetablePdf(studentRows, `Weekly timetable: ${$('s-semester').value} Semester ${SCHOOL_YEAR_LABEL}`));
$('staff-export-csv').addEventListener('click', () => downloadScheduleCsv(staffRows, currentUser?.role === 'admin' ? 'active-period-schedules' : 'teacher-schedule'));
$('staff-export-ics').addEventListener('click', () => downloadScheduleIcs(staffRows, currentUser?.role === 'admin' ? 'active-period-schedules' : 'teacher-schedule', 'staff-export-alert'));
$('staff-export-pdf').addEventListener('click', () => downloadSchedulePdf(staffRows, currentUser?.role === 'admin' ? 'Active period schedules' : 'Teacher schedule'));
$('staff-export-timetable').addEventListener('click', () => downloadTimetablePdf(staffRows, currentUser?.role === 'admin' ? 'Weekly timetable: all schedules' : 'Weekly timetable: my classes'));

let searchTimer;
$('s-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadStudentSchedule, 300);
});
$('s-program').addEventListener('change', loadStudentSchedule);
$('s-year').addEventListener('change', loadStudentSchedule);
$('s-semester').addEventListener('change', loadStudentSchedule);
$('show-login-btn').addEventListener('click', showLogin);
$('back-to-student').addEventListener('click', showStudent);

/* ---------- start ---------- */

(async function init() {
  await detectCaps();
  const { data } = await sb.auth.getSession();
  if (data.session) {
    const profile = await loadProfile(data.session.user);
    if (profile) return showApp(profile);
    await sb.auth.signOut();
  }
  showStudent();
})();