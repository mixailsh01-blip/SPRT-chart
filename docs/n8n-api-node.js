// n8n Code node «API»: реализация docs/API_CONTRACT.md
// Вход: запрос из узла «API webhook» ({ body, headers }), токен из «Pyrus: токен», флаги телефонии из «Телефония: все»,
// обеды из «Обеды: все» (sprt_lunch), смены на ближайшие дни из «Смены: таблица» (sprt_schedule).
// Выход: { status, body, email?, telUpdates?, lunchUpdates?, notify?, mangoSync? }
// Хранилище кодов и сессий — static data воркфлоу (сохраняется только в боевых запусках).

const crypto = require('crypto');

// ---------- настройки ----------
const FORM_SCHEDULE = 2470373;
const FORM_VACATIONS = 2470368;
const CAT_SHIFTS = 309671;
const CAT_DEPARTMENTS = 309670;
const F = { department: 1, person: 2, due: 3, amount: 4, template: 5 }; // поля формы «График работы»
const V = { period: 1, year: 2, person: 3, department: 4, days: 5 }; // поля формы «График отпусков»
const LINES = [
  { key: 'TP', name: 'ТП', editRoles: [1329637] },
  { key: 'PO', name: 'ПО', editRoles: [1329638] },
];
const EDIT_ALL_ROLES = [];
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VACATION_DAYS = 90;
const LOCAL_OFFSET_MS = 240 * 60 * 1000; // UTC+4
const LUNCH_MS = 60 * 60 * 1000; // обед — 1 час, потом сотрудник автоматически возвращается в линию
const LUNCHES_PER_DAY = 1;
const PATH_WHITELIST = [
  /^\/v4\/members$/,
  /^\/v4\/members\/\d+$/,
  /^\/v4\/roles$/,
  new RegExp(`^/v4/catalogs/(${CAT_SHIFTS}|${CAT_DEPARTMENTS})$`),
  new RegExp(`^/v4/forms/(${FORM_SCHEDULE}|${FORM_VACATIONS})/register$`),
];

// ---------- хранилище ----------
const store = $getWorkflowStaticData('global');
if (!store.secret) store.secret = crypto.randomBytes(32).toString('hex');
store.codes = store.codes || {};
store.sessions = store.sessions || {};
const now = Date.now();
for (const [k, v] of Object.entries(store.codes)) if (!v || v.exp < now - 3600e3) delete store.codes[k];
for (const [k, v] of Object.entries(store.sessions)) if (!v || v.exp < now) delete store.sessions[k];

const hmac = (s) => crypto.createHmac('sha256', store.secret).update(String(s)).digest('hex');
const ok = (data, email) => [{ json: { status: 200, body: { ok: true, data }, email: email || null } }];
const fail = (status, code, message, extra = {}) => [
  { json: { status, body: { ok: false, error: { code, message, ...extra } }, email: null } },
];

// ---------- телефония (таблица n8n sprt_telephony: task_id → telephony) ----------
// Нет строки для задачи — считаем включённым.
const telMap = new Map();
for (const it of $('Телефония: все').all()) {
  const r = it.json || {};
  if (r.task_id != null && r.task_id !== '') telMap.set(Number(r.task_id), r.telephony !== false);
}
const withTelephony = (task) => {
  if (task && task.id != null) task.telephony = telMap.has(Number(task.id)) ? telMap.get(Number(task.id)) : true;
  return task;
};

// ---------- обеды (sprt_lunch: одна строка на сотрудника) и смены (sprt_schedule) ----------
const normName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).sort().join(' ');
const localDay = (ms) => new Date(ms + LOCAL_OFFSET_MS).toISOString().slice(0, 10);
const lunchRows = $('Обеды: все').all().map((i) => i.json).filter((r) => r && r.member_id != null && r.member_id !== '');
const scheduleRows = $('Смены: таблица').all().map((i) => i.json).filter((r) => r && r.task_id != null);

// ---------- Pyrus ----------
const http = (opts) => this.helpers.httpRequest({ json: true, ...opts });

// Токен Pyrus получает узел «Pyrus: токен» перед этим узлом (ключ бота хранится только там)
async function pyrusToken() {
  const t = $('Pyrus: токен').first().json.access_token;
  if (!t) throw Object.assign(new Error('Не удалось получить токен Pyrus'), { status: 502 });
  return t;
}

async function pyrus(method, path, body) {
  const token = await pyrusToken();
  const opts = { method, url: `https://api.pyrus.com${path}`, headers: { Authorization: `Bearer ${token}` } };
  if (body) opts.body = body;
  return http(opts);
}

async function members() {
  const c = store.membersCache;
  if (c && c.at > now - 10 * 60e3) return c.list;
  const r = await pyrus('GET', '/v4/members');
  const list = (r.members || []).map((m) => ({
    id: m.id,
    first_name: m.first_name || '',
    last_name: m.last_name || '',
    email: String(m.email || '').trim().toLowerCase(),
    banned: !!m.banned,
    type: m.type,
  }));
  store.membersCache = { at: now, list };
  return list;
}

async function rolesOf(memberId) {
  const r = await pyrus('GET', '/v4/roles');
  return (r.roles || [])
    .filter((role) => !role.banned && (role.member_ids || []).includes(memberId))
    .map((role) => role.id);
}

function permissionsFor(roles) {
  const ids = (roles || []).map(Number);
  const editAll = EDIT_ALL_ROLES.some((r) => ids.includes(r));
  const perms = { ALL: 'view' };
  for (const line of LINES) perms[line.key] = editAll || line.editRoles.some((r) => ids.includes(r)) ? 'edit' : 'view';
  return perms;
}

function currentSession() {
  const h = $('API webhook').first().json.headers || {};
  const auth = String(h.authorization || h.Authorization || '');
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const s = store.sessions[hmac(`s:${token}`)];
  if (!s || s.exp < now) return null;
  return { ...s, key: hmac(`s:${token}`) };
}

function userPayload(s) {
  return {
    user: { id: s.memberId, name: s.name, login: s.email },
    roles: s.roles,
    permissions: permissionsFor(s.roles),
  };
}

// Поле формы/задачи по id, включая вложенные (заголовки/таблицы хранят поля в info.fields / value.fields)
function findFieldDeep(fields, id) {
  for (const f of fields || []) {
    if (!f) continue;
    if (f.id === id) return f;
    const nested = findFieldDeep((f.info && f.info.fields) || (f.value && f.value.fields) || [], id);
    if (nested) return nested;
  }
  return null;
}

// item_id подразделения -> вкладка (справочник кешируется на 10 минут)
async function departmentLines() {
  if (store.deptCache && store.deptCache.at > now - 10 * 60e3) return store.deptCache.map;
  const cat = await pyrus('GET', `/v4/catalogs/${CAT_DEPARTMENTS}`);
  const map = {};
  for (const it of cat.items || []) {
    const name = String((it.values || [])[0] || '').trim().toUpperCase();
    const line = LINES.find((l) => l.name.toUpperCase() === name);
    if (line) map[it.item_id] = line.key;
  }
  store.deptCache = { at: now, map };
  return map;
}

// ---------- обед ----------
// Текущая смена сотрудника (идёт сейчас и он включён в телефонию). Сопоставление — по person_id, иначе по ФИО.
function activeShiftOf(s) {
  const me = normName(s.name);
  return scheduleRows.find((r) => {
    const mine = (r.person_id != null && r.person_id !== '' && Number(r.person_id) === Number(s.memberId)) || normName(r.name) === me;
    const start = new Date(r.start_utc).getTime();
    const end = new Date(r.end_utc).getTime();
    return mine && r.telephony !== false && start <= now && end > now;
  }) || null;
}

const lunchRowOf = (memberId) => lunchRows.find((r) => Number(r.member_id) === Number(memberId)) || null;

function lunchState(s) {
  const shift = activeShiftOf(s);
  const row = lunchRowOf(s.memberId);
  const start = row ? new Date(row.start_utc).getTime() : NaN;
  const isToday = row && !Number.isNaN(start) && localDay(start) === localDay(now);
  const active = !!row && row.status === 'active';
  const scheduled = !!row && row.status === 'scheduled';
  const cancelled = !!row && row.status === 'cancelled';
  const lunch = row && !cancelled && (active || scheduled || isToday)
    ? {
        status: row.status, // scheduled | active | returned | auto
        start_utc: row.start_utc,
        end_utc: row.end_utc,
        ended_at: row.ended_at || null,
        overdue: row.overdue === true,
        remainingSec: active ? Math.max(0, Math.round((new Date(row.end_utc).getTime() - now) / 1000)) : 0,
      }
    : null;
  // Отменённый обед не занимает слот на сегодня — можно запланировать заново
  const usedToday = isToday && !cancelled ? 1 : 0;
  return {
    onShift: !!shift,
    shiftEnd: shift ? shift.end_utc : null,
    lunch,
    lunchMinutes: LUNCH_MS / 60000,
    canStart: !!shift && usedToday < LUNCHES_PER_DAY,
  };
}

const lunchRow = (s, fields) => ({
  member_id: Number(s.memberId),
  name: s.name,
  email: s.email,
  dept: '',
  start_utc: '',
  end_utc: '',
  status: 'returned',
  ended_at: '',
  overdue: false,
  ...fields,
});

const lineByName = (name) => LINES.find((l) => l.name.toUpperCase() === String(name || '').trim().toUpperCase());

// ---------- роутер ----------
const req = $('API webhook').first().json;
const body = req.body || {};
const action = String(body.action || '');
const p = body.payload || {};

try {
  if (action === 'auth.start') {
    const email = String(p.identifier || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'BAD_EMAIL', 'Введите корректный email');
    const m = (await members()).find((x) => x.email === email && !x.banned);
    if (!m) return fail(404, 'NOT_FOUND', 'Email не найден в Pyrus');
    const prev = store.codes[email];
    if (prev && now - prev.sentAt < RESEND_MS) {
      return fail(429, 'RATE_LIMITED', 'Код уже отправлен, подождите', {
        retryAfterSec: Math.ceil((RESEND_MS - (now - prev.sentAt)) / 1000),
      });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    store.codes[email] = { hash: hmac(`c:${email}:${code}`), exp: now + CODE_TTL_MS, attempts: MAX_ATTEMPTS, sentAt: now, memberId: m.id };
    return ok(
      { challengeId: email, ttlSec: CODE_TTL_MS / 1000 },
      { to: m.email, code, name: `${m.first_name} ${m.last_name}`.trim() }
    );
  }

  if (action === 'auth.verify') {
    const email = String(p.identifier || '').trim().toLowerCase();
    const code = String(p.code || '').trim();
    const c = store.codes[email];
    if (!c || c.exp < now) {
      delete store.codes[email];
      return fail(400, 'CODE_EXPIRED', 'Код истёк — запросите новый');
    }
    if (c.attempts <= 0) return fail(429, 'LOCKED', 'Слишком много попыток');
    if (hmac(`c:${email}:${code}`) !== c.hash) {
      c.attempts -= 1;
      return fail(400, c.attempts <= 0 ? 'LOCKED' : 'INVALID_CODE', 'Неверный код', { attemptsLeft: c.attempts });
    }
    delete store.codes[email];
    const m = (await members()).find((x) => x.id === c.memberId);
    const roles = await rolesOf(c.memberId);
    const token = crypto.randomBytes(32).toString('hex');
    const s = {
      memberId: c.memberId,
      email,
      name: m ? `${m.last_name} ${m.first_name}`.trim() : email,
      roles,
      exp: now + SESSION_TTL_MS,
    };
    store.sessions[hmac(`s:${token}`)] = s;
    return ok({ sessionToken: token, ...userPayload(s) });
  }

  // ниже — только с сессией
  const session = currentSession();
  if (!session) return fail(401, 'UNAUTHORIZED', 'Нет сессии или она истекла');

  if (action === 'auth.me') return ok(userPayload(session));

  if (action === 'auth.logout') {
    delete store.sessions[session.key];
    return ok({});
  }

  if (action === 'pyrus.request') {
    const method = String(p.method || 'GET').toUpperCase();
    const path = String(p.path || '').split('?')[0].replace(/\/+$/, '');
    if (method !== 'GET' || !PATH_WHITELIST.some((re) => re.test(path))) {
      return fail(403, 'FORBIDDEN_PATH', `Путь не разрешён: ${method} ${path}`);
    }
    const data = await pyrus('GET', path);
    // В реестр графика добавляем флаг телефонии из таблицы n8n
    if (path === `/v4/forms/${FORM_SCHEDULE}/register` && data && Array.isArray(data.tasks)) data.tasks.forEach(withTelephony);
    return ok(data);
  }

  if (action === 'schedule.save') {
    const perms = permissionsFor(session.roles);
    const changes = p.changes || {};
    const creates = changes.create?.task || [];
    const edits = changes.edit?.task || [];
    const deletes = changes.deleted?.task || [];

    const lineByItem = await departmentLines();
    const canEditItem = (itemId) => perms[lineByItem[itemId]] === 'edit';

    async function assertTaskEditable(taskId) {
      const t = await pyrus('GET', `/v4/tasks/${taskId}`);
      const task = t.task || t;
      if (task.form_id !== FORM_SCHEDULE) throw Object.assign(new Error('Задача не из формы графика'), { status: 403 });
      const dept = (task.fields || []).find((f) => f.id === F.department);
      if (!canEditItem(dept?.value?.item_id)) throw Object.assign(new Error('Нет прав на подразделение задачи'), { status: 403 });
    }

    const fieldsOf = (t) => [
      { id: F.department, value: { item_id: t.department_item_id } },
      { id: F.person, value: { id: t.employee_id } },
      { id: F.due, value: t.start, duration: Number(t.duration) },
      { id: F.amount, value: Number(t.amount || 0) },
      { id: F.template, value: { item_id: t.item_id } },
    ];

    for (const t of [...creates, ...edits]) {
      if (!canEditItem(t.department_item_id)) return fail(403, 'FORBIDDEN', 'Нет прав на редактирование этого подразделения');
    }

    // Запросы к Pyrus идут параллельно (до CONCURRENCY одновременно), а не по одному
    const CONCURRENCY = 6;
    async function runPool(jobs) {
      let i = 0;
      const worker = async () => {
        while (i < jobs.length) {
          const job = jobs[i++];
          await job();
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    }

    // tasks — созданные/изменённые задачи из ответа Pyrus (с флагом telephony), deletedIds — удалённые.
    // Фронт показывает их сразу: реестр Pyrus обновляется с задержкой.
    // telUpdates уходят в узел «Телефония: изменения» → таблица sprt_telephony.
    const result = { created: 0, edited: 0, deleted: 0, errors: [], tasks: [], deletedIds: [], telephonyField: 'n8n:sprt_telephony' };
    const telUpdates = [];
    const rememberTask = (task, telephony) => {
      if (!task || task.id == null) return;
      task.telephony = telephony !== false;
      result.tasks.push(task);
      telUpdates.push({ task_id: task.id, telephony: task.telephony });
    };
    const jobs = [
      ...creates.map((t) => async () => {
        try {
          const r = await pyrus('POST', '/v4/tasks', { form_id: FORM_SCHEDULE, fields: fieldsOf(t) });
          rememberTask(r && r.task, t.telephony);
          result.created++;
        } catch (e) { result.errors.push({ op: 'create', employee_id: t.employee_id, start: t.start, message: e.message }); }
      }),
      ...edits.map((t) => async () => {
        try {
          await assertTaskEditable(t.task_id);
          const r = await pyrus('POST', `/v4/tasks/${t.task_id}/comments`, { field_updates: fieldsOf(t) });
          if (r && r.task) rememberTask(r.task, t.telephony);
          else telUpdates.push({ task_id: t.task_id, telephony: t.telephony !== false });
          result.edited++;
        } catch (e) { result.errors.push({ op: 'edit', task_id: t.task_id, message: e.message }); }
      }),
      ...deletes.map((t) => async () => {
        try {
          await assertTaskEditable(t.task_id);
          await pyrus('DELETE', `/v4/tasks/${t.task_id}`);
          result.deletedIds.push(t.task_id);
          result.deleted++;
        } catch (e) { result.errors.push({ op: 'delete', task_id: t.task_id, message: e.message }); }
      }),
    ];
    await runPool(jobs);
    const out = ok(result);
    out[0].json.telUpdates = telUpdates;
    return out;
  }

  // Обмен сменами: у двух задач формы «График работы» меняется только поле «Сотрудник».
  // Новых задач не создаётся — дублей нет, строки sprt_schedule и флаг телефонии остаются привязаны к task_id.
  // Без target_task_id — передача смены: сотрудник задачи меняется на target_employee_id (у него в этот день не должно быть смены).
  if (action === 'schedule.swap') {
    const perms = permissionsFor(session.roles);
    const idA = Number(p.task_id);
    const idB = p.target_task_id != null && p.target_task_id !== '' ? Number(p.target_task_id) : null;
    const targetEmployee = Number(p.target_employee_id);
    if (!Number.isInteger(idA) || idA <= 0) return fail(400, 'BAD_REQUEST', 'Не указана смена');
    if (idB != null && (!Number.isInteger(idB) || idB <= 0)) return fail(400, 'BAD_REQUEST', 'Не указана смена для обмена');
    if (idB === idA) return fail(400, 'BAD_REQUEST', 'Выберите смену другого сотрудника');
    if (idB == null && (!Number.isInteger(targetEmployee) || targetEmployee <= 0)) return fail(400, 'BAD_REQUEST', 'Не указан сотрудник');

    const lineByItem = await departmentLines();
    const loadShift = async (id) => {
      const t = await pyrus('GET', `/v4/tasks/${id}`);
      const task = t.task || t;
      if (!task || task.form_id !== FORM_SCHEDULE) throw Object.assign(new Error('Задача не из формы графика'), { status: 403 });
      const f = (fid) => (task.fields || []).find((x) => x.id === fid);
      return {
        id: task.id,
        person: Number(f(F.person)?.value?.id) || null,
        line: lineByItem[f(F.department)?.value?.item_id] || null,
        start: new Date(f(F.due)?.value || '').getTime(),
      };
    };
    const a = await loadShift(idA);
    const b = idB != null ? await loadShift(idB) : null;
    if (!a.person || !a.line || Number.isNaN(a.start)) return fail(400, 'BAD_REQUEST', 'В смене не заполнены сотрудник, подразделение или дата');
    if (b && (!b.person || Number.isNaN(b.start))) return fail(400, 'BAD_REQUEST', 'В смене для обмена не заполнены сотрудник или дата');
    if (b && b.line !== a.line) return fail(400, 'BAD_REQUEST', 'Обмен возможен только внутри одного подразделения');
    const newPersonA = b ? b.person : targetEmployee;
    if (newPersonA === a.person) return fail(400, 'BAD_REQUEST', 'Это смены одного сотрудника');

    // Права: редактор подразделения — любые смены; сотрудник — только обмен/передача своей смены
    const me = Number(session.memberId);
    const isEditor = perms[a.line] === 'edit';
    if (!isEditor && me !== a.person && !(b && me === b.person)) {
      return fail(403, 'FORBIDDEN', 'Меняться можно только своими сменами');
    }

    // Проверка дублей: после обмена ни у кого не должно быть двух смен в один день
    const all = await members();
    const nameOf = (id) => {
      const m = all.find((x) => x.id === id);
      return m ? `${m.last_name} ${m.first_name}`.trim() : `#${id}`;
    };
    const reg = await pyrus('GET', `/v4/forms/${FORM_SCHEDULE}/register`);
    const skip = new Set([a.id, b && b.id].filter(Boolean));
    const busy = (personId, dayMs) =>
      (reg.tasks || []).some((t) => {
        if (skip.has(t.id)) return false;
        const f = (fid) => (t.fields || []).find((x) => x.id === fid);
        if (Number(f(F.person)?.value?.id) !== personId) return false;
        const s = new Date(f(F.due)?.value || '').getTime();
        return !Number.isNaN(s) && localDay(s) === localDay(dayMs);
      });
    const fmtDay = (ms) => localDay(ms).split('-').reverse().join('.');
    if (busy(newPersonA, a.start)) {
      return fail(409, 'DUPLICATE', `У сотрудника ${nameOf(newPersonA)} уже есть смена ${fmtDay(a.start)}`);
    }
    if (b && busy(a.person, b.start)) {
      return fail(409, 'DUPLICATE', `У сотрудника ${nameOf(a.person)} уже есть смена ${fmtDay(b.start)}`);
    }

    const note = b
      ? `Обмен сменами: ${nameOf(a.person)} ${fmtDay(a.start)} ⇄ ${nameOf(b.person)} ${fmtDay(b.start)} (График смен, ${session.name})`
      : `Передача смены ${fmtDay(a.start)}: ${nameOf(a.person)} → ${nameOf(newPersonA)} (График смен, ${session.name})`;
    const setPerson = (taskId, personId) =>
      pyrus('POST', `/v4/tasks/${taskId}/comments`, { text: note, field_updates: [{ id: F.person, value: { id: personId } }] });

    const tasks = [];
    const ra = await setPerson(a.id, newPersonA);
    if (ra && ra.task) tasks.push(withTelephony(ra.task));
    if (b) {
      try {
        const rb = await setPerson(b.id, a.person);
        if (rb && rb.task) tasks.push(withTelephony(rb.task));
      } catch (e) {
        // Вторая половина обмена не прошла — возвращаем первую, чтобы не остаться с двумя сменами у одного
        await setPerson(a.id, a.person).catch(() => {});
        throw e;
      }
    }

    // Письма участникам обмена (кроме того, кто его сделал)
    const notify = [];
    for (const pid of [a.person, newPersonA]) {
      const m = all.find((x) => x.id === pid);
      if (!m || !m.email || pid === me) continue;
      notify.push({
        to: m.email,
        subject: b ? 'Обмен сменами в графике SPRT' : 'Вам передана смена в графике SPRT',
        html: `<p>Здравствуйте, ${m.first_name || ''}!</p><p>${note}.</p><p style="color:#5B7483">Проверьте «График смен» SPRT.</p>`,
      });
    }

    const out = ok({ swapped: true, tasks, note });
    out[0].json.notify = notify;
    // Затронуты смены на сегодня — сразу пересобираем группу Манго
    out[0].json.mangoSync = [a.start, b && b.start].some((ms) => ms && localDay(ms) === localDay(now));
    return out;
  }

  // Обед: сотрудник на смене уходит на 1 час — его убирают из группы Манго, через час он возвращается сам
  // (воркфлоу «SPRT: обеды — возврат в линию»). Не вернулся сам — письмо руководителю.
  // Можно начать сразу или запланировать (payload.start_at, ISO) на более позднее время этой же смены —
  // тогда до наступления времени сотрудник остаётся в группе Манго как обычно; тот же воркфлоу раз в
  // минуту переводит запланированный обед в активный и убирает сотрудника из группы.
  if (action === 'lunch.status') return ok(lunchState(session));

  if (action === 'lunch.start') {
    const st = lunchState(session);
    if (st.lunch && (st.lunch.status === 'active' || st.lunch.status === 'scheduled')) return ok(st);
    if (!st.onShift) return fail(400, 'NOT_ON_SHIFT', 'Сейчас у вас нет смены в линии');
    if (!st.canStart) return fail(409, 'LUNCH_USED', 'Обед сегодня уже был');
    const shift = activeShiftOf(session);
    const shiftEndMs = new Date(shift.end_utc).getTime();
    let startAt = now;
    if (p.start_at != null && p.start_at !== '') {
      const t = new Date(p.start_at).getTime();
      if (Number.isNaN(t)) return fail(400, 'BAD_REQUEST', 'Некорректное время начала обеда');
      if (t < now - 60e3) return fail(400, 'BAD_REQUEST', 'Время начала обеда уже прошло');
      if (t >= shiftEndMs) return fail(400, 'BAD_REQUEST', 'Время начала обеда должно быть раньше конца смены');
      startAt = Math.max(t, now);
    }
    const isImmediate = startAt <= now + 30e3;
    const row = lunchRow(session, {
      dept: String(shift.podrazdelenie || ''),
      start_utc: new Date(startAt).toISOString(),
      end_utc: new Date(startAt + LUNCH_MS).toISOString(),
      status: isImmediate ? 'active' : 'scheduled',
    });
    const prev = lunchRowOf(session.memberId);
    if (prev) lunchRows.splice(lunchRows.indexOf(prev), 1);
    lunchRows.push(row);
    const out = ok(lunchState(session));
    out[0].json.lunchUpdates = [row];
    return out;
  }

  if (action === 'lunch.end') {
    const row = lunchRowOf(session.memberId);
    // Запланированный, но ещё не начавшийся обед — отменяем, слот на сегодня освобождается
    if (row && row.status === 'scheduled') {
      const cancelled = lunchRow(session, {
        dept: row.dept || '',
        start_utc: row.start_utc,
        end_utc: row.end_utc,
        status: 'cancelled',
        ended_at: new Date(now).toISOString(),
      });
      lunchRows.splice(lunchRows.indexOf(row), 1, cancelled);
      const out = ok(lunchState(session));
      out[0].json.lunchUpdates = [cancelled];
      return out;
    }
    if (!row || row.status !== 'active') return ok(lunchState(session));
    const updated = lunchRow(session, {
      dept: row.dept || '',
      start_utc: row.start_utc,
      end_utc: row.end_utc,
      status: 'returned',
      ended_at: new Date(now).toISOString(),
      overdue: now > new Date(row.end_utc).getTime(),
    });
    lunchRows.splice(lunchRows.indexOf(row), 1, updated);
    const out = ok(lunchState(session));
    out[0].json.lunchUpdates = [updated];
    return out;
  }

  // Отпуск: задача формы «График отпусков». Период — даты без времени, как их создаёт Pyrus:
  // value = первый день T00:00:00Z, duration = (дней − 1) × 1440.
  if (action === 'vacation.create') {
    const perms = permissionsFor(session.roles);
    const line = LINES.find((l) => l.key === p.line);
    if (!line || perms[line.key] !== 'edit') return fail(403, 'FORBIDDEN', 'Нет прав на редактирование этого подразделения');
    const employeeId = Number(p.employee_id);
    const days = Number(p.days);
    const start = String(p.start_date || '');
    if (!Number.isInteger(employeeId) || employeeId <= 0) return fail(400, 'BAD_REQUEST', 'Не указан сотрудник');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`))) {
      return fail(400, 'BAD_REQUEST', 'Некорректная дата начала отпуска');
    }
    if (!Number.isInteger(days) || days < 1 || days > MAX_VACATION_DAYS) {
      return fail(400, 'BAD_REQUEST', `Длительность отпуска — от 1 до ${MAX_VACATION_DAYS} дней`);
    }

    // choice_id отдела берём из описания формы по названию (кеш 10 минут)
    let choices = store.vacDeptChoices && store.vacDeptChoices.at > now - 10 * 60e3 ? store.vacDeptChoices.map : null;
    if (!choices) {
      const form = await pyrus('GET', `/v4/forms/${FORM_VACATIONS}`);
      const field = findFieldDeep(form.fields || [], V.department);
      choices = {};
      for (const o of (field && field.info && field.info.options) || []) {
        choices[String(o.choice_value || '').trim().toUpperCase()] = o.choice_id;
      }
      store.vacDeptChoices = { at: now, map: choices };
    }
    const choiceId = choices[line.name.toUpperCase()];
    if (choiceId == null) return fail(502, 'BACKEND_ERROR', `В форме отпусков нет отдела «${line.name}»`);

    const period = { id: V.period, value: `${start}T00:00:00Z` };
    if (days > 1) period.duration = (days - 1) * 1440;
    const r = await pyrus('POST', '/v4/tasks', {
      form_id: FORM_VACATIONS,
      fields: [
        period,
        { id: V.year, value: start.slice(0, 4) },
        { id: V.person, value: { id: employeeId } },
        { id: V.department, value: { choice_ids: [choiceId] } },
        { id: V.days, value: days },
      ],
    });
    return ok({ task: (r && r.task) || null });
  }

  if (action === 'vacation.delete') {
    const perms = permissionsFor(session.roles);
    const taskId = Number(p.task_id);
    if (!Number.isInteger(taskId) || taskId <= 0) return fail(400, 'BAD_REQUEST', 'Не указан отпуск');
    const t = await pyrus('GET', `/v4/tasks/${taskId}`);
    const task = t.task || t;
    if (task.form_id !== FORM_VACATIONS) return fail(403, 'FORBIDDEN', 'Задача не из формы отпусков');
    const dept = findFieldDeep(task.fields || [], V.department);
    const line = lineByName(dept && dept.value && (dept.value.choice_names || [])[0]);
    if (!line || perms[line.key] !== 'edit') return fail(403, 'FORBIDDEN', 'Нет прав на отдел этого отпуска');
    await pyrus('DELETE', `/v4/tasks/${taskId}`);
    return ok({ deletedId: taskId });
  }

  return fail(400, 'UNKNOWN_ACTION', `Неизвестный action: ${action}`);
} catch (e) {
  return fail(e.status || 502, 'BACKEND_ERROR', e.message || 'Ошибка бэкенда');
}
