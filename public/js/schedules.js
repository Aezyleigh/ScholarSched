const $ = (id) => document.getElementById(id);
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null; // { id, name, role, teacher_id }
let staffRows = [];     // schedules shown to the signed-in staff member
let lookups = { subjects: [], programs: [], years: [], teachers: [], rooms: [], availability: [], curriculum: [] };
let editingId = null;   // id of the schedule being edited, or null when creating
let editingPairId = null;
let currentSemester = null;
let editingCurriculumId = null;

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_START = 7 * 60;   // room availability is shown between 7:00 AM ...
const DAY_END = 20 * 60;    // ... and 8:00 PM

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
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

function roleLabel(role) {
  return { admin: 'Program Head', teacher: 'Teacher' }[role] || role;
}

/* ---------- views ---------- */

function showLogin() {
  currentUser = null;
  $('app-view').hidden = true;
  $('student-view').hidden = true;
  $('login-view').hidden = false;
}

function showTab(name) {
  ['schedules', 'reports', 'curriculum'].forEach((t) => {
    $(`tab-${t}`).hidden = t !== name;
    document.querySelector(`[data-tab="${t}"]`).setAttribute('aria-selected', String(t === name));
  });
  if (name === 'reports') renderReport();
  if (name === 'curriculum') renderCurriculum();
}

async function showApp(user) {
  currentUser = user;
  $('login-view').hidden = true;
  $('student-view').hidden = true;
  $('app-view').hidden = false;
  $('user-label').textContent = `${user.name} (${roleLabel(user.role)})`;

  const isAdmin = user.role === 'admin';
  $('app-tabs').hidden = !isAdmin;
  $('create-panel').hidden = !isAdmin;
  document.querySelectorAll('.admin-only').forEach((el) => (el.hidden = !isAdmin));
  $('list-title').textContent = isAdmin ? 'All schedules' : 'My published schedule';
  $('search-input').value = '';
  resetForm();
  showTab('schedules');

  if (isAdmin) await loadLookups();
  else await loadPeriodLabel();
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
  errBox.hidden = true;

  const { data, error } = await sb.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  if (error) {
    errBox.textContent = 'Invalid email or password';
    errBox.hidden = false;
    return;
  }

  const profile = await loadProfile(data.user);
  if (!profile) {
    await sb.auth.signOut();
    errBox.textContent = 'This account has no role assigned. Ask the Program Head.';
    errBox.hidden = false;
    return;
  }
  $('login-password').value = '';
  showApp(profile);
});

$('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut();
  showStudent();
});

/* ---------- period label and dropdowns ---------- */

async function loadPeriodLabel() {
  const { data } = await sb
    .from('scheduling_periods')
    .select('academic_year, semester')
    .eq('is_active', true)
    .maybeSingle();
  currentSemester = data?.semester || null;
  $('period-label').textContent = data
    ? `${data.academic_year}, ${data.semester} Semester`
    : 'No active scheduling period';
}

function updateSubjectOptions() {
  const programId = $('f-program').value;
  const yearId = $('f-year').value;
  const assigned = new Set(lookups.curriculum
    .filter((c) => String(c.program_id) === programId && String(c.year_level_id) === yearId && c.semester === currentSemester)
    .map((c) => String(c.subject_id)));
  const rows = lookups.subjects.filter((s) => assigned.has(String(s.id)));
  const select = $('f-subject');
  const previous = select.value;
  select.innerHTML = '<option value="">Select a course from this curriculum</option>' + rows
    .map((s) => `<option value="${esc(s.id)}">${esc(s.subject_code)} – ${esc(s.subject_name)}</option>`).join('');
  if (rows.some((s) => String(s.id) === previous)) select.value = previous;
  $('subject-note').textContent = rows.length ? '' : 'Assign courses for this program, year, and active semester in the Curriculum tab.';
}
$('f-program').addEventListener('change', updateSubjectOptions);
$('f-year').addEventListener('change', updateSubjectOptions);
function fillSelect(id, rows, labelFn) {
  $(id).innerHTML = rows
    .map((r) => `<option value="${esc(r.id)}">${esc(labelFn(r))}</option>`)
    .join('');
}

async function loadLookups() {
  const [subjects, programs, years, teachers, rooms, availability, curriculum] = await Promise.all([
    sb.from('subjects').select('id, subject_code, subject_name, units, prerequisite').order('subject_code'),
    sb.from('programs').select('id, program_name').order('program_name'),
    sb.from('year_levels').select('id, year_level').order('id'),
    sb.from('teachers').select('id, teacher_name, max_load_hours').order('teacher_name'),
    sb.from('rooms').select('id, room_name, is_online').order('room_name'),
    sb.from('teacher_availability').select('teacher_id, day, start_time, end_time').order('day'),
    sb.from('curriculum_courses').select('id, subject_id, program_id, year_level_id, semester').order('semester'),
  ]);
  lookups = {
    subjects: subjects.data || [], programs: programs.data || [], years: years.data || [],
    teachers: teachers.data || [], rooms: rooms.data || [], availability: availability.data || [],
    curriculum: curriculum.data || [],
  };
  fillSelect('f-program', lookups.programs, (r) => r.program_name);
  fillSelect('f-year', lookups.years, (r) => r.year_level);
  fillSelect('f-teacher', lookups.teachers, (r) => r.teacher_name);
  fillSelect('f-room', lookups.rooms, (r) => r.room_name);
  fillSelect('curriculum-subject', lookups.subjects, (r) => `${r.subject_code} – ${r.subject_name}`);
  fillSelect('curriculum-program', lookups.programs, (r) => r.program_name);
  fillSelect('curriculum-year', lookups.years, (r) => r.year_level);
  fillSelect('r-program', lookups.programs, (r) => r.program_name);
  fillSelect('r-year', lookups.years, (r) => r.year_level);
  fillSelect('r-teacher', lookups.teachers, (r) => r.teacher_name);
  fillSelect('r-room', lookups.rooms, (r) => r.room_name);
  renderCurriculum();
  await loadPeriodLabel();
  updateSubjectOptions();
}

function showCurriculumAlert(id, type, message) {
  const box = $(id);
  box.className = `alert ${type}`;
  box.textContent = message;
  box.hidden = false;
}

function renderCurriculum() {
  const subjects = lookups.subjects || [];
  const subjectById = new Map(subjects.map((s) => [String(s.id), s]));
  const programById = new Map(lookups.programs.map((p) => [String(p.id), p]));
  const yearById = new Map(lookups.years.map((y) => [String(y.id), y]));
  $('course-body').innerHTML = subjects.map((s) => `
    <tr><td>${esc(s.subject_code)}</td><td>${esc(s.subject_name)}</td><td>${esc(s.units)}</td>
    <td>${esc(s.prerequisite || '—')}</td><td><button type="button" data-edit-course="${s.id}">Edit</button></td></tr>`).join('');
  $('curriculum-body').innerHTML = (lookups.curriculum || []).map((c) => {
    const s = subjectById.get(String(c.subject_id));
    const p = programById.get(String(c.program_id));
    const y = yearById.get(String(c.year_level_id));
    if (!s || !p || !y) return '';
    return `<tr><td>${esc(s.subject_code)} – ${esc(s.subject_name)}</td><td>${esc(p.program_name)}</td>
      <td>${esc(y.year_level)}</td><td>${esc(c.semester)}</td>
      <td><button type="button" data-edit-curriculum="${c.id}">Edit</button> <button type="button" class="danger" data-remove-curriculum="${c.id}">Remove</button></td></tr>`;
  }).join('');
}

$('course-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit-course]');
  if (!btn) return;
  const s = lookups.subjects.find((row) => String(row.id) === btn.dataset.editCourse);
  if (!s) return;
  $('course-id').value = s.id;
  $('course-code').value = s.subject_code;
  $('course-name').value = s.subject_name;
  $('course-units').value = s.units;
  $('course-prerequisite').value = s.prerequisite || '';
  $('course-submit').textContent = 'Save course';
  $('course-cancel').hidden = false;
});

$('course-cancel').addEventListener('click', () => {
  $('course-form').reset();
  $('course-id').value = '';
  $('course-submit').textContent = 'Add course';
  $('course-cancel').hidden = true;
  $('course-alert').hidden = true;
});

$('course-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('course-id').value;
  const values = {
    subject_code: $('course-code').value.trim(),
    subject_name: $('course-name').value.trim(),
    units: Number($('course-units').value),
    prerequisite: $('course-prerequisite').value.trim() || null,
  };
  const { error } = id
    ? await sb.from('subjects').update(values).eq('id', Number(id))
    : await sb.from('subjects').insert(values);
  if (error) return showCurriculumAlert('course-alert', 'error', 'Could not save the course. Check that its code is unique.');
  $('course-form').reset();
  $('course-id').value = '';
  $('course-submit').textContent = 'Add course';
  $('course-cancel').hidden = true;
  showCurriculumAlert('course-alert', 'ok', id ? 'Course updated.' : 'Course added.');
  await loadLookups();
});

$('curriculum-cancel').addEventListener('click', () => {
  editingCurriculumId = null;
  $('curriculum-form').reset();
  $('curriculum-submit').textContent = 'Add to curriculum';
  $('curriculum-cancel').hidden = true;
  $('curriculum-alert').hidden = true;
});

$('curriculum-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = {
    subject_id: Number($('curriculum-subject').value),
    program_id: Number($('curriculum-program').value),
    year_level_id: Number($('curriculum-year').value),
    semester: $('curriculum-semester').value,
  };
  const { error } = editingCurriculumId
    ? await sb.from('curriculum_courses').update(values).eq('id', editingCurriculumId)
    : await sb.from('curriculum_courses').insert(values);
  if (error) return showCurriculumAlert('curriculum-alert', 'error', 'Could not save this curriculum entry. It may already exist.');
  const wasEditing = editingCurriculumId !== null;
  editingCurriculumId = null;
  $('curriculum-form').reset();
  $('curriculum-submit').textContent = 'Add to curriculum';
  $('curriculum-cancel').hidden = true;
  showCurriculumAlert('curriculum-alert', 'ok', wasEditing ? 'Curriculum entry updated.' : 'Course added to the curriculum.');
  await loadLookups();
});

$('curriculum-body').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-curriculum]');
  if (edit) {
    const row = lookups.curriculum.find((c) => String(c.id) === edit.dataset.editCurriculum);
    if (!row) return;
    editingCurriculumId = row.id;
    $('curriculum-subject').value = row.subject_id;
    $('curriculum-program').value = row.program_id;
    $('curriculum-year').value = row.year_level_id;
    $('curriculum-semester').value = row.semester;
    $('curriculum-submit').textContent = 'Save curriculum';
    $('curriculum-cancel').hidden = false;
    return;
  }
  const btn = e.target.closest('[data-remove-curriculum]');
  if (!btn || !confirm('Remove this course from the curriculum?')) return;
  const { error } = await sb.from('curriculum_courses').delete().eq('id', Number(btn.dataset.removeCurriculum));
  if (error) return showCurriculumAlert('curriculum-alert', 'error', 'Could not remove this curriculum entry.');
  showCurriculumAlert('curriculum-alert', 'ok', 'Curriculum entry removed.');
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
               scheduling_periods!inner(is_active)`)
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
    }));
  }
  const { data, error } = await sb.from('teacher_schedule').select('*');
  return error ? null : data;
}

async function loadSchedules() {
  const rows = await fetchStaffSchedules();
  if (!rows) {
    staffRows = [];
    $('schedule-body').innerHTML = '';
    return;
  }
  staffRows = sortSchedules(rows);
  renderStaffTable();
  if (!$('tab-reports').hidden) renderReport();
}

function renderStaffTable() {
  const isAdmin = currentUser.role === 'admin';
  const q = $('search-input').value.trim().toLowerCase();
  const rows = q
    ? staffRows.filter((s) =>
        [s.subject_code, s.subject_name, s.teacher_name, s.room_name, s.program_name, s.year_level, s.day, s.status]
          .join(' ').toLowerCase().includes(q))
    : staffRows;

  $('schedule-body').innerHTML = rows.map((s) => `
    <tr>
      <td>${esc(s.subject_code)} – ${esc(s.subject_name)}</td>
      <td>${esc(s.program_name)}, ${esc(s.year_level)}</td>
      <td>${esc(s.teacher_name)}</td>
      <td>${esc(s.room_name)}</td>
      <td>${esc(s.day)}</td>
      <td>${to12h(s.start_time)} – ${to12h(s.end_time)}</td>
      <td><span class="badge ${esc(s.status)}">${esc(s.status)}</span></td>
      ${isAdmin ? `<td class="actions">${actionButtons(s)}</td>` : ''}
    </tr>`).join('');

  const empty = $('empty-msg');
  empty.hidden = rows.length > 0;
  if (staffRows.length === 0) {
    empty.textContent = isAdmin ? 'No schedules yet. Create one above.' : 'Nothing is published for you yet.';
  } else {
    empty.textContent = `No schedule matches "${$('search-input').value.trim()}".`;
  }
}

$('search-input').addEventListener('input', renderStaffTable);

function actionButtons(s) {
  const paired = s.schedule_pair_id ? 'data-paired="true"' : '';
  const edit = `<button data-id="${s.id}" ${paired} data-action="edit">Edit</button>`;
  if (s.status === 'DRAFT') {
    return `${edit}
            <button data-id="${s.id}" ${paired} data-action="publish" class="primary">Publish</button>
            <button data-id="${s.id}" ${paired} data-action="delete" class="danger">Delete</button>`;
  }
  return `${edit}
          <button data-id="${s.id}" ${paired} data-action="unpublish">Unpublish</button>`;
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
  const { id, action, paired } = btn.dataset;

  if (action === 'edit') return startEdit(Number(id));
  if (action === 'delete' && !confirm(paired ? 'Delete both draft days in this paired schedule?' : 'Delete this draft schedule?')) return;

  btn.disabled = true;
  const res = await changeStatus(Number(id), action);
  showFormAlert(res.ok ? 'ok' : 'error', res.ok ? res.message : res.error);
  loadSchedules();
});

/* ---------- create and edit schedule ---------- */

function showFormAlert(type, message, list = []) {
  const box = $('form-alert');
  box.className = `alert ${type}`;
  box.innerHTML = esc(message) +
    (list.length ? `<ul>${list.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '');
  box.hidden = false;
}

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
  $('form-title').textContent = 'Create schedule';
  $('form-submit').textContent = 'Check conflicts and save as draft';
  $('form-cancel').hidden = true;
}

function updateClassEnd() {
  const start = $('f-start').value;
  if (!start) { $('f-end').value = ''; return; }
  const end = toMin(start) + 150;
  $('f-end').value = end < 24 * 60 ? minToTime(end).slice(0, 5) : '';
}
$('f-start').addEventListener('input', updateClassEnd);
$('f-start').addEventListener('change', updateClassEnd);
function startEdit(id) {
  const s = staffRows.find((r) => r.id === id);
  if (!s) return;
  editingId = id;
  editingPairId = s.schedule_pair_id;
  $('f-program').value = s.program_id;
  $('f-year').value = s.year_level_id;
  updateSubjectOptions();
  $('f-subject').value = s.subject_id;
  $('f-teacher').value = s.teacher_id;
  $('f-room').value = s.room_id;
  const pairedDays = editingPairId
    ? staffRows.filter((r) => r.schedule_pair_id === editingPairId).map((r) => r.day).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
    : [];
  $('f-day').value = pairedDays.length === 2 ? pairedDays.join('|') : s.day;
  $('f-start').value = s.start_time.slice(0, 5);
  updateClassEnd();
  $('form-title').textContent = `Edit schedule: ${s.subject_code}`;
  $('form-submit').textContent = 'Check conflicts and save changes';
  $('form-cancel').hidden = false;
  $('form-alert').hidden = true;
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

  const days = $('f-day').value.split('|');
  if (editingPairId && days.length !== 2) {
    return showFormAlert('error', 'Keep paired schedules paired. Cancel and create a new schedule to change between single and paired days.');
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
  } else if (data.ok) {
    resetForm();
    showFormAlert('ok', wasEditing ? 'Changes saved.' : 'Saved as draft.');
    loadSchedules();
  } else if (data.conflicts) {
    showFormAlert('error', 'The schedule was not saved. Fix the following:', data.conflicts.map(friendlyScheduleMessage));
  } else {
    showFormAlert('error', 'The schedule was not saved. Reason:', [friendlyScheduleMessage(data.error)]);
  }
});

/* ---------- reports (Program Head) ---------- */

$('app-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) showTab(btn.dataset.tab);
});
['r-type', 'r-program', 'r-year', 'r-teacher', 'r-room'].forEach((id) =>
  $(id).addEventListener('change', renderReport));
$('r-print').addEventListener('click', () => window.print());

const COLS = {
  subject: ['Subject', (s) => `${esc(s.subject_code)} – ${esc(s.subject_name)}`],
  group: ['Program and year', (s) => `${esc(s.program_name)}, ${esc(s.year_level)}`],
  teacher: ['Teacher', (s) => esc(s.teacher_name)],
  room: ['Room', (s) => esc(s.room_name)],
  day: ['Day', (s) => esc(s.day)],
  time: ['Time', (s) => `${to12h(s.start_time)} – ${to12h(s.end_time)}`],
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

const slotText = ([a, b]) => `${to12h(minToTime(a))} – ${to12h(minToTime(b))}`;

function availabilityText(teacherId) {
  return lookups.availability.filter((a) => String(a.teacher_id) === String(teacherId))
    .sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day))
    .map((a) => `${a.day.slice(0, 3)} ${to12h(a.start_time)}–${to12h(a.end_time)}`).join('; ') || 'Not configured';
}
function renderReport() {
  if (!currentUser || currentUser.role !== 'admin') return;
  const type = $('r-type').value;
  $('r-program-wrap').hidden = type !== 'class';
  $('r-year-wrap').hidden = type !== 'class';
  $('r-teacher-wrap').hidden = type !== 'faculty';
  $('r-room-wrap').hidden = !(type === 'room' || type === 'availability');

  const out = $('report-output');
  const meta = `<p class="muted report-meta">${esc($('period-label').textContent)} · Generated ${esc(new Date().toLocaleDateString())}</p>`;
  const pick = (id, list, key) => list.find((x) => String(x.id) === $(id).value);

  if (type === 'class') {
    const program = pick('r-program', lookups.programs);
    const year = pick('r-year', lookups.years);
    if (!program || !year) { out.innerHTML = ''; return; }
    const rows = staffRows.filter((s) => String(s.program_id) === String(program.id) && String(s.year_level_id) === String(year.id));
    out.innerHTML = `<h3>Class schedule: ${esc(program.program_name)}, ${esc(year.year_level)}</h3>${meta}` +
      scheduleTable(rows, ['subject', 'teacher', 'room', 'day', 'time', 'status']);
  } else if (type === 'faculty-all') {
    const rows = lookups.teachers.map((teacher) => {
      const classes = staffRows.filter((s) => String(s.teacher_id) === String(teacher.id));
      const load = classes.reduce((n, s) => n + hoursOf(s), 0);
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
    const total = rows.reduce((n, s) => n + hoursOf(s), 0);
    out.innerHTML = `<h3>Faculty schedule: ${esc(teacher.teacher_name)}</h3>${meta}` +
      `<p><strong>Teaching load:</strong> ${round1(total)} of ${esc(teacher.max_load_hours)} hours per week</p>` +
      `<p><strong>Availability:</strong> ${esc(availabilityText(teacher.id))}</p>` +
      scheduleTable(rows, ['subject', 'group', 'room', 'day', 'time', 'status']);
  } else if (type === 'room') {
    const room = pick('r-room', lookups.rooms);
    if (!room) { out.innerHTML = ''; return; }
    const rows = staffRows.filter((s) => String(s.room_id) === String(room.id));
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
    const body = DAY_ORDER.map((day) => {
      const dayRows = sortSchedules(roomRows.filter((s) => s.day === day));
      const occupied = dayRows.map((s) => `${to12h(s.start_time)} – ${to12h(s.end_time)} (${esc(s.subject_code)})`).join('<br>') || '<span class="muted">None</span>';
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

/* ---------- student view (no login) ---------- */

async function showStudent() {
  currentUser = null;
  $('app-view').hidden = true;
  $('login-view').hidden = true;
  $('student-view').hidden = false;

  const [period, programs, years] = await Promise.all([
    sb.from('scheduling_periods').select('academic_year, semester').eq('is_active', true).maybeSingle(),
    sb.from('programs').select('id, program_name').order('program_name'),
    sb.from('year_levels').select('id, year_level').order('id'),
  ]);

  $('student-period').textContent = period.data
    ? `${period.data.academic_year}, ${period.data.semester} Semester`
    : '';

  const withPlaceholder = (label, rows, labelKey) =>
    `<option value="">${label}</option>` +
    (rows || []).map((r) => `<option value="${esc(r.id)}">${esc(r[labelKey])}</option>`).join('');

  $('s-program').innerHTML = withPlaceholder('Select program', programs.data, 'program_name');
  $('s-year').innerHTML = withPlaceholder('Select year level', years.data, 'year_level');

  // Remember the last choice on this device (convenience only)
  try {
    const saved = JSON.parse(localStorage.getItem('scholarsched_student') || '{}');
    if (saved.program) $('s-program').value = saved.program;
    if (saved.year) $('s-year').value = saved.year;
  } catch (_) { /* storage unavailable */ }

  loadStudentSchedule();
}

async function loadStudentSchedule() {
  const program = $('s-program').value;
  const year = $('s-year').value;
  // Remove characters that have a special meaning in the search filter
  const term = $('s-search').value.replace(/[%,()*\\]/g, ' ').trim();
  const body = $('student-body');
  const empty = $('student-empty');

  try {
    localStorage.setItem('scholarsched_student', JSON.stringify({ program, year }));
  } catch (_) { /* storage unavailable */ }

  let query = sb.from('student_schedule').select('*');
  if (term.length >= 2) {
    query = query.or(`subject_code.ilike.%${term}%,subject_name.ilike.%${term}%`);
  } else if (program && year) {
    query = query.eq('program_id', Number(program)).eq('year_level_id', Number(year));
  } else {
    body.innerHTML = '';
    empty.textContent = 'Choose your program and year level, or search for a subject.';
    empty.hidden = false;
    return;
  }

  const { data, error } = await query;
  if (error) {
    body.innerHTML = '';
    empty.textContent = 'Could not load the schedule.';
    empty.hidden = false;
    return;
  }

  sortSchedules(data);
  body.innerHTML = data.map((s) => `
    <tr>
      <td>${esc(s.subject_code)} – ${esc(s.subject_name)}</td>
      <td>${esc(s.program_name)}, ${esc(s.year_level)}</td>
      <td>${esc(s.teacher_name)}</td>
      <td>${esc(s.room_name)}</td>
      <td>${esc(s.day)}</td>
      <td>${to12h(s.start_time)} – ${to12h(s.end_time)}</td>
    </tr>`).join('');

  empty.hidden = data.length > 0;
  empty.textContent = term.length >= 2
    ? `No published class matches "${term}".`
    : 'No published schedule for this program and year level yet.';
}

let searchTimer;
$('s-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadStudentSchedule, 300);
});
$('s-program').addEventListener('change', loadStudentSchedule);
$('s-year').addEventListener('change', loadStudentSchedule);
$('show-login-btn').addEventListener('click', showLogin);
$('back-to-student').addEventListener('click', showStudent);

/* ---------- start ---------- */

(async function init() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    const profile = await loadProfile(data.session.user);
    if (profile) return showApp(profile);
    await sb.auth.signOut();
  }
  showStudent();
})();
