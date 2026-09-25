// n8n Code node «API»: реализация docs/API_CONTRACT.md
// Вход: запрос из узла «API webhook» ({ body, headers }), токен из «Pyrus: токен», флаги телефонии из «Телефония: все».
// Выход: { status, body, email?, telUpdates? }
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

    // item_id подразделения -> вкладка (справочник кешируется на 10 минут)
    let lineByItem = store.deptCache && store.deptCache.at > now - 10 * 60e3 ? store.deptCache.map : null;
    if (!lineByItem) {
      const cat = await pyrus('GET', `/v4/catalogs/${CAT_DEPARTMENTS}`);
      lineByItem = {};
      for (const it of cat.items || []) {
        const name = String((it.values || [])[0] || '').trim().toUpperCase();
        const line = LINES.find((l) => l.name.toUpperCase() === name);
        if (line) lineByItem[it.item_id] = line.key;
      }
      store.deptCache = { at: now, map: lineByItem };
    }
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
