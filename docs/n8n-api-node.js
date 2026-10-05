// n8n Code node «API»: реализация docs/API_CONTRACT.md
// Вход: запрос из узла «API webhook» ({ body, headers }), токен из «Pyrus: токен», флаги телефонии из «Телефония: все»,
// обеды из «Обеды: все» (sprt_lunch), смены на ближайшие дни из «Смены: таблица» (sprt_schedule).
// Выход: { status, body, email?, telUpdates?, lunchUpdates?, notify?, mangoSync?, pyrusNotify? }
// Хранилище кодов и сессий — static data воркфлоу (сохраняется только в боевых запусках).

const crypto = require('crypto');

// ---------- настройки ----------
const FORM_SCHEDULE = 2470373;
const FORM_VACATIONS = 2470368;
const CAT_SHIFTS = 309671;
const CAT_DEPARTMENTS = 309670;
const F = { department: 1, person: 2, due: 3, amount: 4, template: 5 }; // поля формы «График работы»
const V = { period: 1, year: 2, person: 3, department: 4, days: 5, approved: 7 }; // поля формы «График отпусков»
const LINES = [
  { key: 'TP', name: 'ТП', editRoles: [1329637], memberRoles: [1329812] },
  { key: 'PO', name: 'ПО', editRoles: [1329638], memberRoles: [] },
];
const ADMIN_ROLES = [1331784]; // полный админ: все смены, шаблоны смен, выдача ролей
const EDIT_ALL_ROLES = [...ADMIN_ROLES];
const SCHEDULE_EDITOR_ROLE = 1329637; // редактор графика ТП
const HR_ROLE = 1300681; // менеджер по персоналу: согласует отпуска
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VACATION_DAYS = 90;
const LOCAL_OFFSET_MS = 240 * 60 * 1000; // UTC+4
const DAILY_LUNCH_BUDGET_MS = 60 * 60 * 1000; // суммарно 1 час обеда в сутки — можно расходовать за сколько угодно заходов
const MIN_LUNCH_SEGMENT_MS = 60 * 1000; // меньше минуты остатка — считаем лимит исчерпанным
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
const ok = (data, email, extra = {}) => [{ json: { status: 200, body: { ok: true, data }, email: email || null, ...extra } }];
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

// Текст ошибки вместе с ответом Pyrus (иначе видно только «Request failed with status code 400»)
function errText(e) {
  let d = e && (e.context && e.context.data || e.cause && e.cause.response && e.cause.response.data || e.response && (e.response.data || e.response.body) || e.description);
  if (d && typeof d !== 'string') { try { d = JSON.stringify(d); } catch (_) { d = ''; } }
  const m = (e && e.message) || 'Ошибка бэкенда';
  return d ? `${m}: ${String(d).slice(0, 300)}` : m;
}

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
  for (const line of LINES) {
    if (editAll || line.editRoles.some((r) => ids.includes(r))) perms[line.key] = 'edit';
    // Обычный сотрудник отдела: правит только свои смены/отпуска
    else if ((line.memberRoles || []).some((r) => ids.includes(r))) perms[line.key] = 'self';
    else perms[line.key] = 'view';
  }
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

const isAdminRoles = (roles) => (roles || []).map(Number).some((r) => ADMIN_ROLES.includes(r));

function userPayload(s) {
  return {
    user: { id: s.memberId, name: s.name, login: s.email },
    roles: s.roles,
    permissions: permissionsFor(s.roles),
    isAdmin: isAdminRoles(s.roles),
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

// Сегменты обеда сотрудника за сегодня (несколько записей в sprt_lunch — по одной на каждое «ушёл/вернулся»),
// без отменённых. Общий лимит — DAILY_LUNCH_BUDGET_MS в сутки, использовать можно сколько угодно заходов подряд.
const todaysSegments = (memberId) =>
  lunchRows
    .filter((r) => Number(r.member_id) === Number(memberId) && r.status !== 'cancelled')
    .filter((r) => localDay(new Date(r.start_utc).getTime()) === localDay(now));

const openSegmentOf = (memberId) => todaysSegments(memberId).find((r) => r.status === 'active' || r.status === 'scheduled') || null;

// Сколько уже «потрачено» сегодня: у активного — сколько прошло с начала, у закрытых — фактическая длительность.
function usedMsToday(memberId) {
  return todaysSegments(memberId).reduce((sum, r) => {
    const start = new Date(r.start_utc).getTime();
    if (r.status === 'active') return sum + Math.max(0, now - start);
    if (r.status === 'scheduled') return sum; // ещё не начался — бюджет не тронут
    const end = r.ended_at ? new Date(r.ended_at).getTime() : new Date(r.end_utc).getTime();
    return sum + Math.max(0, end - start);
  }, 0);
}

function lunchState(s) {
  const shift = activeShiftOf(s);
  const row = openSegmentOf(s.memberId);
  const active = !!row && row.status === 'active';
  const usedMs = usedMsToday(s.memberId);
  const remainingMs = Math.max(0, DAILY_LUNCH_BUDGET_MS - usedMs);
  const lunch = row
    ? {
        status: row.status, // scheduled | active
        start_utc: row.start_utc,
        end_utc: row.end_utc,
        overdue: false,
        remainingSec: active ? Math.max(0, Math.round((new Date(row.end_utc).getTime() - now) / 1000)) : 0,
      }
    : null;
  return {
    onShift: !!shift,
    shiftEnd: shift ? shift.end_utc : null,
    lunch,
    lunchMinutes: DAILY_LUNCH_BUDGET_MS / 60000, // суточный лимит (не длительность одного захода)
    budgetRemainingSec: Math.round(remainingMs / 1000),
    canStart: !!shift && !row && remainingMs >= MIN_LUNCH_SEGMENT_MS,
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
    const link = crypto.randomBytes(18).toString('base64url'); // одноразовый токен для ссылки «войти одним кликом»
    store.codes[email] = { hash: hmac(`c:${email}:${code}`), linkHash: hmac(`l:${link}`), exp: now + CODE_TTL_MS, attempts: MAX_ATTEMPTS, sentAt: now, memberId: m.id };
    const name = `${m.first_name} ${m.last_name}`.trim();
    // Продублировать код в Pyrus (задача на форме «Уведомления сотрудникам», form_id 2472006, поле 8 «Тип» =
    // choice_id 1 «Авторизация в график», поле 6 «Почта» = email, поле 9 «Пин-код» = код) — кнопка «Войти в
    // график» (custom_url: .../?li_email=${email}&li_code=${password}) сама собирает ссылку и кодирует
    // значения полей; здесь пишем «сырые» email/код, без ручного кодирования. Письмо иногда попадает в спам,
    // а в Pyrus сотрудник видит уведомление сразу.
    return ok(
      { challengeId: email, ttlSec: CODE_TTL_MS / 1000 },
      { to: m.email, code, name, link },
      { pyrusNotify: { memberId: m.id, email, code, link } }
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
    if (hmac(`c:${email}:${code}`) !== c.hash && !(c.linkHash && hmac(`l:${code}`) === c.linkHash)) {
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

  // Вход по одноразовой ссылке (?li=токен): в адресе нет ни почты, ни кода
  if (action === 'auth.link') {
    const linkHash = hmac(`l:${String(p.token || '').trim()}`);
    const email = Object.keys(store.codes).find((k) => store.codes[k].linkHash === linkHash);
    const c = email && store.codes[email];
    if (!c || c.exp < now) {
      if (email) delete store.codes[email];
      return fail(400, 'INVALID_LINK', 'Ссылка устарела — запросите новый код');
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

  if (action === 'auth.me') {
    // Роли обновляем из Pyrus при каждом входе на страницу — выданная роль подхватывается без перелогина
    try {
      const fresh = await rolesOf(session.memberId);
      if (store.sessions[session.key]) store.sessions[session.key].roles = fresh;
      session.roles = fresh;
    } catch (_) { /* оставляем роли из сессии */ }
    return ok(userPayload(session));
  }

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
    const me = Number(session.memberId);
    // 'edit' — любые строки отдела; 'self' — только свои (employeeId = текущий пользователь)
    const canEditItem = (itemId, employeeId) => {
      const perm = perms[lineByItem[itemId]];
      return perm === 'edit' || (perm === 'self' && Number(employeeId) === me);
    };

    async function assertTaskEditable(taskId, newEmployeeId) {
      const t = await pyrus('GET', `/v4/tasks/${taskId}`);
      const task = t.task || t;
      if (task.form_id !== FORM_SCHEDULE) throw Object.assign(new Error('Задача не из формы графика'), { status: 403 });
      const dept = (task.fields || []).find((f) => f.id === F.department);
      const person = Number((task.fields || []).find((f) => f.id === F.person)?.value?.id) || null;
      if (!canEditItem(dept?.value?.item_id, person)) throw Object.assign(new Error('Нет прав на подразделение задачи'), { status: 403 });
      if (newEmployeeId !== undefined && !canEditItem(dept?.value?.item_id, newEmployeeId)) throw Object.assign(new Error('Нет прав назначать смену этому сотруднику'), { status: 403 });
    }

    const fieldsOf = (t) => {
      const fields = [
        { id: F.department, value: { item_id: t.department_item_id } },
        { id: F.person, value: { id: t.employee_id } },
        { id: F.due, value: t.start, duration: Number(t.duration) },
        { id: F.amount, value: Number(t.amount || 0) },
      ];
      // Поле «Смена» — только для смен по шаблону; при ручном вводе времени шаблона нет, поле не трогаем
      if (t.item_id != null && t.item_id !== '') fields.push({ id: F.template, value: { item_id: Number(t.item_id) } });
      // Шаблонная смена стала кастомной (правка): очищаем поле «Смена»
      else if (t.clear_template) fields.push({ id: F.template, value: null });
      return fields;
    };

    for (const t of [...creates, ...edits]) {
      if (!canEditItem(t.department_item_id, t.employee_id)) return fail(403, 'FORBIDDEN', 'Нет прав на редактирование этого подразделения или сотрудника');
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
        } catch (e) { result.errors.push({ op: 'create', employee_id: t.employee_id, start: t.start, message: errText(e) }); }
      }),
      ...edits.map((t) => async () => {
        try {
          await assertTaskEditable(t.task_id, t.employee_id);
          const r = await pyrus('POST', `/v4/tasks/${t.task_id}/comments`, { field_updates: fieldsOf(t) });
          if (r && r.task) rememberTask(r.task, t.telephony);
          else telUpdates.push({ task_id: t.task_id, telephony: t.telephony !== false });
          result.edited++;
        } catch (e) { result.errors.push({ op: 'edit', task_id: t.task_id, message: errText(e) }); }
      }),
      ...deletes.map((t) => async () => {
        try {
          await assertTaskEditable(t.task_id);
          await pyrus('DELETE', `/v4/tasks/${t.task_id}`);
          result.deletedIds.push(t.task_id);
          result.deleted++;
        } catch (e) { result.errors.push({ op: 'delete', task_id: t.task_id, message: errText(e) }); }
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

  // Обед: сотрудник на смене уходит из группы Манго на время обеда. Суточный лимит — DAILY_LUNCH_BUDGET_MS
  // (1 час), расходовать можно за сколько угодно заходов — включать и выключать в течение смены. Заход можно
  // начать сразу или запланировать (payload.start_at, ISO) на более позднее время этой же смены — тогда до
  // наступления времени сотрудник остаётся в группе как обычно; воркфлоу «SPRT: обеды — возврат в линию» раз в
  // минуту переводит запланированный заход в активный (убирает из группы) и закрывает просроченный активный
  // заход (возвращает в группу, шлёт письмо руководителю, если сотрудник не вернулся сам).
  if (action === 'lunch.status') return ok(lunchState(session));

  if (action === 'lunch.start') {
    const st = lunchState(session);
    if (st.lunch) return ok(st); // уже есть открытый заход (активный или запланированный)
    if (!st.onShift) return fail(400, 'NOT_ON_SHIFT', 'Сейчас у вас нет смены в линии');
    if (!st.canStart) return fail(409, 'LUNCH_USED', 'Лимит обеда на сегодня исчерпан');
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
    // Заход ограничен остатком суточного лимита на момент старта (а не всегда часом)
    const allotMs = Math.max(MIN_LUNCH_SEGMENT_MS, DAILY_LUNCH_BUDGET_MS - usedMsToday(session.memberId));
    const row = lunchRow(session, {
      dept: String(shift.podrazdelenie || ''),
      start_utc: new Date(startAt).toISOString(),
      end_utc: new Date(startAt + allotMs).toISOString(),
      status: isImmediate ? 'active' : 'scheduled',
    });
    lunchRows.push(row); // новая запись — заходов за день может быть несколько, старые не трогаем
    const out = ok(lunchState(session));
    out[0].json.lunchUpdates = [row]; // без id — «Обед: изменения» создаст новую строку в sprt_lunch
    return out;
  }

  if (action === 'lunch.end') {
    const row = openSegmentOf(session.memberId);
    if (!row) return ok(lunchState(session));
    // Запланированный, но ещё не начавшийся заход — отменяем, потраченное время не списывается
    const updated = row.status === 'scheduled'
      ? lunchRow(session, { id: row.id, dept: row.dept || '', start_utc: row.start_utc, end_utc: row.end_utc, status: 'cancelled', ended_at: new Date(now).toISOString() })
      : lunchRow(session, {
          id: row.id,
          dept: row.dept || '',
          start_utc: row.start_utc,
          end_utc: row.end_utc,
          status: 'returned',
          ended_at: new Date(now).toISOString(),
          overdue: now > new Date(row.end_utc).getTime(),
        });
    lunchRows.splice(lunchRows.indexOf(row), 1, updated);
    const out = ok(lunchState(session));
    out[0].json.lunchUpdates = [updated]; // с id — «Обед: изменения» обновит существующую строку
    return out;
  }


  // ---------- Настройки: шаблоны смен (справочник Pyrus «смены») ----------
  // Админ — шаблоны для «ВСЕ» и для ТП; редактор графика — только для ТП.
  const SHIFT_CAT_COLS = { name: 'Названия смен', time: 'Время работы', amount: 'Сумма за смену', dept: 'Отдел' };
  const deptTokenOf = (raw) => String(raw || '').trim().toUpperCase();
  const shiftsCatalog = async () => {
    const r = await pyrus('GET', `/v4/catalogs/${CAT_SHIFTS}`);
    const cat = Array.isArray(r) ? r[0] : r;
    const headers = (cat.catalog_headers || []).map((h) => String((h && h.name) || h || '').trim());
    const col = (title, fallbacks) => {
      let i = headers.findIndex((h) => h.toLowerCase() === title.toLowerCase());
      if (i < 0) i = headers.findIndex((h) => fallbacks.some((f) => h.toLowerCase().includes(f)));
      return i;
    };
    return {
      cat,
      headers,
      items: cat.items || [],
      idx: {
        name: Math.max(0, col(SHIFT_CAT_COLS.name, ['назван', 'смен'])),
        time: col(SHIFT_CAT_COLS.time, ['время']),
        amount: col(SHIFT_CAT_COLS.amount, ['сумм']),
        dept: col(SHIFT_CAT_COLS.dept, ['отдел', 'подразд']),
      },
    };
  };
  // Можно ли пользователю менять шаблон с таким значением колонки «Отдел»
  const canManageTemplate = (roles, deptRaw) => {
    if (isAdminRoles(roles)) return true;
    const perms = permissionsFor(roles);
    const tokens = deptTokenOf(deptRaw).split(/[,/;]/).map((t) => t.trim()).filter(Boolean);
    return perms.TP === 'edit' && tokens.length === 1 && tokens[0] === 'ТП';
  };

  if (action === 'settings.shift.save') {
    const name = String(p.name || '').trim();
    const time = String(p.time || '').trim();
    const amount = Number(p.amount || 0);
    const dept = String(p.dept || '').trim().toUpperCase() === 'ТП' ? 'ТП' : 'ВСЕ';
    if (!name || name.length > 60) return fail(400, 'BAD_REQUEST', 'Укажите название смены (до 60 символов)');
    if (!/^\d{1,2}[:.]\d{2}\s*-\s*\d{1,2}[:.]\d{2}$/.test(time)) return fail(400, 'BAD_REQUEST', 'Время смены — в формате 08:00-20:00');
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) return fail(400, 'BAD_REQUEST', 'Некорректная сумма');
    if (!canManageTemplate(session.roles, dept)) return fail(403, 'FORBIDDEN', 'Нет прав на шаблоны смен этого отдела');
    const sc = await shiftsCatalog();
    // Нельзя перезаписать чужой шаблон с тем же названием
    const existing = sc.items.find((it) => String((it.values || [])[sc.idx.name] || '').trim().toUpperCase() === name.toUpperCase());
    if (existing && !canManageTemplate(session.roles, sc.idx.dept >= 0 ? (existing.values || [])[sc.idx.dept] : '')) {
      return fail(403, 'FORBIDDEN', 'Шаблон с таким названием уже есть и вам недоступен');
    }
    if (sc.idx.name !== 0) return fail(502, 'BACKEND_ERROR', 'Название смены должно быть первой колонкой справочника');
    const values = sc.headers.map(() => '');
    values[sc.idx.name] = name;
    if (sc.idx.time >= 0) values[sc.idx.time] = time.replace(/\s+/g, '');
    if (sc.idx.amount >= 0) values[sc.idx.amount] = String(amount);
    if (sc.idx.dept >= 0) values[sc.idx.dept] = dept;
    const rows = sc.items.map((it) => ({ values: (it.values || []).map((v) => String(v == null ? '' : v)) }));
    const at = rows.findIndex((r) => String(r.values[sc.idx.name] || '').trim().toUpperCase() === name.toUpperCase());
    if (at >= 0) rows[at] = { values }; else rows.push({ values });
    await pyrus('POST', `/v4/catalogs/${CAT_SHIFTS}`, { apply: true, catalog_headers: sc.headers, items: rows });
    return ok({ saved: name });
  }

  if (action === 'settings.shift.delete') {
    const itemId = Number(p.item_id);
    if (!Number.isInteger(itemId) || itemId <= 0) return fail(400, 'BAD_REQUEST', 'Не указан шаблон');
    const sc = await shiftsCatalog();
    const item = sc.items.find((it) => Number(it.item_id) === itemId);
    if (!item) return fail(404, 'NOT_FOUND', 'Шаблон не найден');
    if (!canManageTemplate(session.roles, sc.idx.dept >= 0 ? (item.values || [])[sc.idx.dept] : '')) {
      return fail(403, 'FORBIDDEN', 'Нет прав на удаление этого шаблона');
    }
    const key = String((item.values || [])[sc.idx.name] || '');
    const rows = sc.items
      .filter((it) => Number(it.item_id) !== itemId)
      .map((it) => ({ values: (it.values || []).map((v) => String(v == null ? '' : v)) }));
    await pyrus('POST', `/v4/catalogs/${CAT_SHIFTS}`, { apply: true, catalog_headers: sc.headers, items: rows });
    return ok({ deleted: key });
  }

  // ---------- Настройки: выдача ролей (только полный админ) ----------
  if (action === 'settings.role.set') {
    if (!isAdminRoles(session.roles)) return fail(403, 'FORBIDDEN', 'Роли выдаёт только администратор');
    const memberId = Number(p.member_id);
    const grant = p.grant !== false;
    const roleKey = String(p.role || '');
    const roleId = roleKey === 'admin' ? ADMIN_ROLES[0] : roleKey === 'editor' ? SCHEDULE_EDITOR_ROLE : null;
    if (!Number.isInteger(memberId) || memberId <= 0 || roleId == null) return fail(400, 'BAD_REQUEST', 'Не указан сотрудник или роль');
    if (!grant && roleKey === 'admin' && memberId === Number(session.memberId)) {
      return fail(400, 'BAD_REQUEST', 'Нельзя снять админку с самого себя');
    }
    const all = await members();
    if (!all.some((m) => m.id === memberId && !m.banned)) return fail(404, 'NOT_FOUND', 'Сотрудник не найден');
    await pyrus('PUT', `/v4/roles/${roleId}`, grant ? { member_add: [memberId] } : { member_remove: [memberId] });
    // Уже выданные сессии этого человека обновляем сразу, без повторного входа
    for (const sess of Object.values(store.sessions)) {
      if (Number(sess.memberId) !== memberId) continue;
      const set = new Set((sess.roles || []).map(Number));
      if (grant) set.add(roleId); else set.delete(roleId);
      sess.roles = [...set];
    }
    return ok({ member_id: memberId, role: roleKey, granted: grant });
  }

  // Отпуск: задача формы «График отпусков». Период — даты без времени, как их создаёт Pyrus:
  // value = первый день T00:00:00Z, duration = (дней − 1) × 1440.
  if (action === 'vacation.create') {
    const perms = permissionsFor(session.roles);
    const line = LINES.find((l) => l.key === p.line);
    // Админ и менеджер по персоналу добавляют отпуск любому сотруднику (отдел можно не указывать)
    const isHr = isAdminRoles(session.roles) || (session.roles || []).map(Number).includes(HR_ROLE);
    const canVac = isHr || (line && (perms[line.key] === 'edit' || (perms[line.key] === 'self' && Number(p.employee_id) === Number(session.memberId))));
    if (!canVac) return fail(403, 'FORBIDDEN', 'Нет прав на редактирование этого подразделения');
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
    const choiceId = line ? choices[line.name.toUpperCase()] : null;
    if (line && choiceId == null) return fail(502, 'BACKEND_ERROR', `В форме отпусков нет отдела «${line.name}»`);

    const period = { id: V.period, value: `${start}T00:00:00Z` };
    if (days > 1) period.duration = (days - 1) * 1440;
    const r = await pyrus('POST', '/v4/tasks', {
      form_id: FORM_VACATIONS,
      fields: [
        period,
        { id: V.year, value: start.slice(0, 4) },
        { id: V.person, value: { id: employeeId } },
        ...(choiceId != null ? [{ id: V.department, value: { choice_ids: [choiceId] } }] : []),
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
    const vacPerson = Number(findFieldDeep(task.fields || [], V.person)?.value?.id) || null;
    const isHrDel = isAdminRoles(session.roles) || (session.roles || []).map(Number).includes(HR_ROLE);
    const canDelVac = isHrDel || (line && (perms[line.key] === 'edit' || (perms[line.key] === 'self' && vacPerson === Number(session.memberId))));
    if (!canDelVac) return fail(403, 'FORBIDDEN', 'Нет прав на отдел этого отпуска');
    await pyrus('DELETE', `/v4/tasks/${taskId}`);
    return ok({ deletedId: taskId });
  }

  // Согласование отпуска (флажок «Согласован»): админ или менеджер по персоналу
  if (action === 'vacation.approve') {
    const roleIds = (session.roles || []).map(Number);
    if (!ADMIN_ROLES.some((r) => roleIds.includes(r)) && !roleIds.includes(HR_ROLE)) {
      return fail(403, 'FORBIDDEN', 'Согласовывать отпуска могут менеджер по персоналу и админ');
    }
    const taskId = Number(p.task_id);
    if (!Number.isInteger(taskId) || taskId <= 0) return fail(400, 'BAD_REQUEST', 'Не указан отпуск');
    const t = await pyrus('GET', `/v4/tasks/${taskId}`);
    const task = t.task || t;
    if (task.form_id !== FORM_VACATIONS) return fail(403, 'FORBIDDEN', 'Задача не из формы отпусков');
    const approved = p.approved === true;
    await pyrus('POST', `/v4/tasks/${taskId}/comments`, {
      field_updates: [{ id: V.approved, value: approved ? 'checked' : 'unchecked' }],
    });
    return ok({ taskId, approved });
  }

  return fail(400, 'UNKNOWN_ACTION', `Неизвестный action: ${action}`);
} catch (e) {
  return fail(e.status || 502, 'BACKEND_ERROR', errText(e));
}

