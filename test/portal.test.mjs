import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPortal } from '../server/portal.mjs';
import { createScheduleEvents } from '../server/schedule-events.mjs';
import { openDatabase } from '../server/database.mjs';
import { mangoGroups, scheduleRows } from '../server/routing.mjs';

const env = { PUBLIC_URL: 'https://portal.sprt-service.ru', MANGO_WRITE_ENABLED: 'false' };
const member = { id: 10, first_name: 'Иван', last_name: 'Петров', email: 'user@example.test' };
const request = (action, payload = {}, token) => ({
  body: { action, payload }, headers: token ? { authorization: 'Bearer ' + token } : {},
});

test('код и сессия сохраняются в SQLite, а код можно использовать только один раз', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sprt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'portal.sqlite');
  const mail = [];
  const notifications = [];
  const pyrus = async (method, path, body) => {
    if (path === '/v4/members') return { members: [member] };
    if (path === '/v4/roles') return { roles: [] };
    if (path === '/v4/tasks' && method === 'POST') {
      notifications.push(body);
      return { task: { id: 55 } };
    }
    throw new Error('Unexpected API: ' + method + ' ' + path);
  };
  const dependencies = {
    pyrus, env, sendMail: async message => { mail.push(message); },
    mango: async () => assert.fail('Mango disabled'),
  };
  const first = createPortal({ ...dependencies, db: openDatabase(filename) });
  const start = await first.act(request('auth.start', { identifier: member.email }));
  assert.equal(start.status, 200);
  assert.equal(mail.length, 1);
  assert.equal(notifications.length, 1);
  const link = notifications[0].fields.find(field => field.id === 9).value;
  assert.match(mail[0].text, new RegExp('portal\\.sprt-service\\.ru/\\?li=' + link));
  const restarted = createPortal({ ...dependencies, db: openDatabase(filename) });
  const login = await restarted.act(request('auth.link', { token: link }));
  assert.equal(login.status, 200);
  const token = login.body.data.sessionToken;
  assert.equal((await restarted.act(request('auth.link', { token: link }))).status, 400);
  const anotherRestart = createPortal({ ...dependencies, db: openDatabase(filename) });
  assert.equal((await anotherRestart.act(request('auth.me', {}, token))).status, 200);
  assert.equal((await anotherRestart.act(request('lunch.list', {}, token))).status, 200);
  assert.equal((await anotherRestart.act(request('auth.logout', {}, token))).status, 200);
  assert.equal((await anotherRestart.act(request('auth.me', {}, token))).status, 401);
});

test('смена берётся из Pyrus, а настройки телефонии и обеды влияют на группу Mango', () => {
  const now = Date.parse('2026-11-16T08:00:00Z');
  const tasks = [{ id: 45, fields: [
    { id: 1, value: { values: ['ТП'] } },
    { id: 2, value: { id: member.id } },
    { id: 3, value: '2026-11-16T07:00:00Z', duration: 360 },
  ] }];
  const members = [member];
  const mangoUsers = [
    { user_id: '10', number: '101', user_name: 'Иван Петров' },
    { user_id: '11', number: '102', user_name: 'Анна Иванова' },
  ];
  const rosterRows = [
    { dept: 'TP', name: 'Петров Иван', mango_user_id: '10', person_id: member.id },
    { dept: 'TP', name: 'Иванова Анна', mango_user_id: '11' },
  ];
  const context = { mangoUsers, rosterRows, groupId: '20624288', now };
  const schedules = scheduleRows({ now, tasks, members, telephony: [] });
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].telephony, true);
  const [normal] = mangoGroups({ ...context, schedules, lunches: [] });
  assert.deepEqual(normal.payload.group.operators, [{ id: '10' }]);
  assert.equal(normal.isFallback, false);
  const [lunch] = mangoGroups({ ...context, schedules, lunches: [
    { member_id: member.id, name: 'Иван Сидоров', status: 'active', overdue: true },
  ] });
  assert.equal(lunch.isFallback, true);
  assert.deepEqual(lunch.payload.group.operators, [{ id: '11' }]);
  const custom = scheduleRows({ now, tasks, members, telephony: [
    { task_id: 45, telephony: false, duration_min: 90 },
  ] });
  assert.equal(custom[0].telephony, false);
  assert.equal(custom[0].end_utc, '2026-11-16T08:30:00.000Z');
});

test('просроченный обед остаётся активным до ручного возврата и создаёт уведомления один раз', async () => {
  const db = openDatabase(':memory:');
  const notifications = [];
  const pyrus = async (method, path, body) => {
    if (path === '/v4/members') return { members: [member] };
    if (path === '/v4/roles') return { roles: [] };
    if (path === '/v4/forms/2470373/register') return { tasks: [{ id: 47, fields: [
      { id: 1, value: { values: ['ТП'] } },
      { id: 2, value: { id: member.id } },
      { id: 3, value: new Date(Date.now() - 60_000).toISOString(), duration: 120 },
    ] }] };
    if (path === '/v4/tasks') {
      notifications.push(body);
      return { task: { id: 58 + notifications.length } };
    }
    throw new Error('Unexpected API: ' + method + ' ' + path);
  };
  const mail = [];
  const portal = createPortal({
    db, pyrus, env: { ...env, LUNCH_ALERT_EMAIL: 'manager@example.test' }, sendMail: async message => { mail.push(message); },
    mango: async () => assert.fail('Mango disabled'),
  });
  await portal.tick();
  assert.equal(db.schedules.all().length, 1);
  await portal.act(request('auth.start', { identifier: member.email }));
  const code = mail[0].text.match(/Код: (\d{6})/)[1];
  const login = await portal.act(request('auth.verify', { identifier: member.email, code }));
  const token = login.body.data.sessionToken;
  assert.equal((await portal.act(request('lunch.start', {}, token))).status, 200);
  const [active] = db.lunches.all();
  assert.equal(active.status, 'active');
  const previousDay = Date.now() - 25 * 60 * 60_000;
  db.lunches.put(active.id, {
    ...active,
    start_utc: new Date(previousDay - 20 * 60_000).toISOString(),
    end_utc: new Date(previousDay).toISOString(),
  });
  await portal.tick();
  await portal.tick();
  const [expired] = db.lunches.all();
  assert.equal(expired.status, 'active');
  assert.equal(expired.overdue, true);
  assert.equal(expired.ended_at, active.ended_at);
  const status = await portal.act(request('lunch.status', {}, token));
  assert.equal(status.body.data.lunch.status, 'active');
  assert.equal(status.body.data.lunch.overdue, true);
  assert.deepEqual(notifications.slice(1).map(task => task.fields.find(field => field.id === 3).value.id), [1195524, member.id]);
  assert.equal(mail.filter(message => message.to === 'manager@example.test').length, 1);
  await portal.act(request('lunch.end', {}, token));
  assert.equal(db.lunches.all()[0].status, 'returned');
});

test('подписчик видит сохранение и удаление до обновления реестра Pyrus', async () => {
  const db = openDatabase(':memory:');
  const editor = { ...member, roles: [] };
  let registeredTasks = [];
  let shift;
  const pyrus = async (method, path, body) => {
    if (path === '/v4/members') return { members: [editor] };
    if (path === '/v4/roles') return { roles: [{ id: 1331784, member_ids: [editor.id] }] };
    if (path === '/v4/catalogs/309670') return { items: [{ item_id: 5, values: ['ТП'] }] };
    if (path === '/v4/forms/2470373/register') return structuredClone({ tasks: registeredTasks });
    if (path === '/v4/tasks' && method === 'POST' && body.form_id === 2472006) return { task: { id: 80 } };
    if (path === '/v4/tasks' && method === 'POST') {
      shift = { id: 91, form_id: body.form_id, fields: body.fields, last_modified_date: '2026-11-16T12:00:00Z' };
      return { task: structuredClone(shift) };
    }
    if (path === '/v4/tasks/91' && method === 'GET') return { task: structuredClone(shift) };
    if (path === '/v4/tasks/91' && method === 'DELETE') return {};
    throw new Error('Unexpected API: ' + method + ' ' + path);
  };
  const mail = [];
  const services = { db, env, pyrus, mango: async () => {}, sendMail: async message => { mail.push(message); } };
  const portal = createPortal(services);
  await portal.act(request('auth.start', { identifier: editor.email }));
  const code = mail[0].text.match(/Код: (\d{6})/)[1];
  const loggedIn = await portal.act(request('auth.verify', { identifier: editor.email, code }));
  const token = loggedIn.body.data.sessionToken;
  const events = createScheduleEvents(portal);
  const fragments = [];
  const connection = new EventEmitter();
  connection.writeHead = (_status, headers) => {
    assert.match(headers['Content-Type'], /^text\/event-stream/);
  };
  connection.write = chunk => { fragments.push(chunk); return true; };
  connection.end = () => connection.emit('close');
  assert.equal(events.open({ headers: {} }, connection), false);
  assert.equal(events.open({ headers: { authorization: 'Bearer ' + token } }, connection), true);

  const register = request('pyrus.request', { path: '/v4/forms/2470373/register' }, token);
  try {
    const save = await portal.act(request('schedule.save', { changes: { create: { task: [{
      department_item_id: 5, employee_id: editor.id, item_id: 20,
      start: '2026-11-17T05:00:00Z', duration: 540, telephony: false,
    }] } } }, token));
    assert.equal(save.body.data.created, 1);
    assert.equal(fragments.length, 2);
    assert.match(fragments.at(-1), /^event: schedule/);
    const fresh = (await portal.act(register)).body.data.tasks;
    assert.equal(fresh[0].id, shift.id);
    assert.equal(fresh[0].telephony, false);

    registeredTasks = [shift];
    const deleted = await portal.act(request('schedule.save', {
      changes: { deleted: { task: [{ task_id: shift.id }] } },
    }, token));
    assert.equal(deleted.body.data.deleted, 1);
    assert.equal(fragments.length, 3);
    const restarted = createPortal(services);
    assert.deepEqual((await restarted.act(register)).body.data.tasks, []);
  } finally {
    events.close();
  }
});

test('роль 1331872 редактирует смены вне ТП из вкладки ВСЕ', async () => {
  const db = openDatabase(':memory:');
  const other = { id: 11, first_name: 'Анна' };
  const support = { id: 12, first_name: 'Олег' };
  const supportAssignment = { id: 13, first_name: 'Елена' };
  const tpDepartmentId = 5;
  const otherDepartmentId = 6;
  const date = '2026-11-17T05:00:00Z';
  const taskFor = (id, employeeId, departmentId) => ({
    id, form_id: 2470373, fields: [
      { id: 1, value: { item_id: departmentId } },
      { id: 2, value: { id: employeeId } },
      { id: 3, value: date },
    ],
  });
  const tpTask = taskFor(100, supportAssignment.id, tpDepartmentId);
  const existing = taskFor(101, other.id, otherDepartmentId);
  const editedExisting = { ...existing, fields: existing.fields.map(field => ({ ...field })) };
  const writes = [];
  let granted = true;
  const pyrus = async (method, path, body) => {
    if (path === '/v4/members') return { members: [member, other, support, supportAssignment] };
    if (path === '/v4/contacts') return { organizations: [{ persons: [
      { id: other.id, department_name: 'Бухгалтерия' },
    ] }] };
    if (path === '/v4/roles') return { roles: [
      { id: 1331872, member_ids: granted ? [member.id] : [] },
      { id: 1329812, member_ids: [support.id] },
    ] };
    if (path === '/v4/catalogs/309670') return { items: [
      { item_id: tpDepartmentId, values: ['ТП'] },
      { item_id: otherDepartmentId, values: ['Бухгалтерия'] },
    ] };
    if (path === '/v4/catalogs/309671') return {
      catalog_headers: [{ name: 'Названия смен' }, { name: 'Отдел' }],
      items: [
        { item_id: 20, values: ['СМЕНА 2/2', 'ТП'] },
        { item_id: 21, values: ['СМЕНА 5/2', 'ВСЕ'] },
      ],
    };
    if (path === '/v4/forms/2470373/register') return structuredClone({ tasks: [tpTask, existing] });
    if (path === '/v4/tasks' && method === 'POST' && body.form_id === 2472006) return { task: { id: 900 } };
    if (path === '/v4/tasks' && method === 'POST') {
      writes.push(body.fields);
      return { task: { id: 102, form_id: body.form_id, fields: body.fields } };
    }
    if (method === 'GET' && path === '/v4/tasks/100') return { task: tpTask };
    if (method === 'GET' && path === '/v4/tasks/101') return { task: existing };
    if (method === 'POST' && path === '/v4/tasks/101/comments') {
      writes.push(body.field_updates);
      return { task: editedExisting };
    }
    throw new Error('Unexpected API: ' + method + ' ' + path);
  };
  const mail = [];
  const portal = createPortal({
    db, pyrus, env, sendMail: async message => { mail.push(message); }, mango: async () => {},
  });
  await portal.act(request('auth.start', { identifier: member.email }));
  const code = mail[0].text.match(/Код: (\d{6})/)[1];
  const login = await portal.act(request('auth.verify', { identifier: member.email, code }));
  const token = login.body.data.sessionToken;
  assert.equal(login.body.data.permissions.ALL, 'edit');
  assert.equal(login.body.data.permissions.TP, 'view');

  const save = (change, task) => portal.act(request('schedule.save', {
    meta: { line: 'ALL' }, changes: { [change]: { task: [task] } },
  }, token));
  const create = employee_id => ({ employee_id, start: date, duration: 480 });
  assert.equal((await save('create', create(support.id))).status, 403);
  assert.equal((await save('create', create(supportAssignment.id))).status, 403);
  assert.equal((await save('create', { ...create(other.id), department_item_id: tpDepartmentId })).status, 403);
  const forbiddenDelete = await save('deleted', { task_id: tpTask.id });
  assert.equal(forbiddenDelete.body.data.deleted, 0);
  assert.equal(writes.length, 0);

  const wrongTemplate = await save('create', { ...create(other.id), item_id: 20 });
  assert.equal(wrongTemplate.status, 403);
  assert.equal(wrongTemplate.body.error.code, 'FORBIDDEN_TEMPLATE');
  assert.equal(writes.length, 0);
  assert.equal((await save('create', { ...create(other.id), item_id: 21 })).body.data.created, 1);
  assert.equal(writes[0].find(field => field.id === 1).value.item_id, otherDepartmentId);
  const wrongEdit = await save('edit', { ...create(other.id), task_id: existing.id, item_id: 20 });
  assert.equal(wrongEdit.body.data.edited, 0);
  assert.equal(writes.length, 1);
  assert.equal((await save('edit', { ...create(other.id), task_id: existing.id, item_id: 21 })).body.data.edited, 1);
  assert.equal(writes[1].some(field => field.id === 1), false);

  granted = false;
  assert.equal((await save('create', create(other.id))).status, 403);
  assert.equal(writes.length, 2);
});

test('роль 1331872 может добавлять, переносить и удалять отпуска сотрудников ТП', async () => {
  const db = openDatabase(':memory:');
  const employee = { id: 20, first_name: 'Павел', last_name: 'Иванов' };
  const office = { id: 21, first_name: 'Мария', department_name: 'Офис' };
  let shifts = [];
  let granted = true;
  let task = { id: 77, form_id: 2470368, fields: [
    { id: 1, type: 'due_date_time', value: '2026-11-16T00:00:00Z', duration: 4320 },
    { id: 3, type: 'person', value: { id: employee.id } },
    { id: 4, value: { choice_names: ['ТП'] } },
    { id: 7, type: 'checkmark', value: 'checked' },
  ] };
  const writes = [];
  const pyrus = async (method, path, body) => {
    if (path === '/v4/members') return { members: [member, employee, office] };
    if (path === '/v4/contacts') return { organizations: [] };
    if (path === '/v4/roles') return { roles: [
      { id: 1331872, member_ids: granted ? [member.id] : [] },
      { id: 1329812, member_ids: [employee.id] },
    ] };
    if (path === '/v4/catalogs/309670') return { items: [
      { item_id: 5, values: ['ТП'] }, { item_id: 6, values: ['Офис'] },
    ] };
    if (path === '/v4/forms/2470373/register') return { tasks: shifts };
    if (path === '/v4/forms/2470368') return { fields: [
      { id: 4, info: { options: [{ choice_value: 'ТП', choice_id: 1 }] } },
    ] };
    if (path === '/v4/tasks' && method === 'POST' && body.form_id === 2472006) return { task: { id: 900 } };
    if (path === '/v4/tasks' && method === 'POST' && body.form_id === 2470368) {
      writes.push(body.fields);
      return { task: { id: 78, fields: body.fields } };
    }
    if (path === '/v4/tasks/77' && method === 'GET') return { task };
    if (path === '/v4/tasks/77/comments' && method === 'POST') {
      writes.push(body.field_updates);
      const updates = new Map(body.field_updates.map(field => [field.id, field]));
      task = { ...task, fields: task.fields.map(field => ({ ...field, ...updates.get(field.id) })) };
      return { task };
    }
    if (path === '/v4/tasks/77' && method === 'DELETE') return {};
    if (path === '/v4/tasks/99' && method === 'GET') return { task: { id: 99, form_id: 2470373 } };
    throw new Error('Unexpected API: ' + method + ' ' + path);
  };
  const mail = [];
  const portal = createPortal({
    db, pyrus, env, sendMail: async message => { mail.push(message); }, mango: async () => {},
  });
  await portal.act(request('auth.start', { identifier: member.email }));
  const code = mail[0].text.match(/Код: (\d{6})/)[1];
  const login = await portal.act(request('auth.verify', { identifier: member.email, code }));
  const token = login.body.data.sessionToken;
  const act = (action, params) => portal.act(request(action, params, token));
  const period = { task_id: 77, start_date: '2026-12-01', days: 1 };

  const vacation = { line: 'ALL', employee_id: employee.id, start_date: '2026-11-23', days: 2 };
  const makeShift = (id, person, department, start) => ({ id, fields: [
    { id: 1, value: { item_id: department } },
    { id: 2, value: { id: person } },
    { id: 3, value: start, duration: 600 },
  ] });
  shifts = [
    // 22:00 по Самаре накануне первого дня отпуска.
    makeShift(91, employee.id, 5, '2026-11-22T18:00:00Z'),
    makeShift(92, office.id, 6, '2026-11-23T05:00:00Z'),
  ];
  const refused = await act('vacation.create', vacation);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /23\.11\.2026/);
  assert.equal(writes.length, 0);
  assert.equal((await act('vacation.create', { ...vacation, employee_id: office.id })).status, 200);
  writes.length = 0;

  shifts = [];
  const created = await act('vacation.create', vacation);
  assert.equal(created.status, 200);
  assert.deepEqual(writes[0].find(field => field.id === 4).value.choice_ids, [1]);
  shifts = [makeShift(93, employee.id, 5, '2026-12-01T05:00:00Z')];
  assert.equal((await act('vacation.update', period)).status, 409);
  shifts = [];
  const updated = await act('vacation.update', period);
  assert.equal(updated.status, 200);
  assert.deepEqual(writes[1], [
    { id: 1, value: '2026-12-01T00:00:00Z', duration: 0 },
    { id: 2, value: '2026' }, { id: 5, value: 1 },
  ]);
  assert.equal(updated.body.data.task.fields.find(field => field.id === 7).value, 'checked');
  assert.equal((await act('vacation.update', { ...period, start_date: '2026-02-30' })).status, 400);
  assert.equal((await act('vacation.update', { ...period, task_id: 99 })).status, 403);
  assert.equal((await act('vacation.approve', { task_id: 77, approved: false })).status, 403);
  assert.equal((await act('vacation.delete', { task_id: 77 })).status, 200);

  granted = false;
  assert.equal((await act('vacation.update', period)).status, 403);
  assert.equal((await act('vacation.delete', { task_id: 77 })).status, 403);
  assert.equal(writes.length, 2);
});

test('администратор меняет доступ шаблона, когда название и ключ в разных колонках', async () => {
  const db = openDatabase(':memory:');
  const editor = { id: 11, email: 'editor@example.test' };
  const items = [
    { item_id: 100, values: ['shift-5-2', 'СМЕНА 5/2', '09:00-18:00', '0', 'ТП', 'Доп. значение'] },
    { item_id: 101, values: ['shift-2-2', 'СМЕНА 2/2', '9:00-21:00', '0', 'ТП', 'Другая строка'] },
  ];
  const writes = [];
  const pyrus = async (method, path, body) => {
    if (path === '/v4/members') return { members: [member, editor] };
    if (path === '/v4/roles') return { roles: [
      { id: 1331784, member_ids: [member.id] }, { id: 1329637, member_ids: [editor.id] },
    ] };
    if (path === '/v4/tasks' && method === 'POST' && body.form_id === 2472006) return { task: { id: 900 } };
    if (path === '/v4/catalogs/309671' && method === 'GET') {
      return {
        catalog_headers: ['Код', 'Названия смен', 'Время работы', 'Сумма за смену', 'Отдел', 'Дополнительно']
          .map(name => ({ name })),
        items: structuredClone(items),
      };
    }
    if (path === '/v4/catalogs/309671/diff' && method === 'POST') {
      writes.push(body);
      return { updated: [{ item_id: 100, values: body.upsert[0].values }] };
    }
    throw new Error('Unexpected API: ' + method + ' ' + path);
  };
  const mail = [];
  const portal = createPortal({
    db, pyrus, env, sendMail: async message => { mail.push(message); }, mango: async () => {},
  });
  async function login(email) {
    await portal.act(request('auth.start', { identifier: email }));
    const code = mail.at(-1).text.match(/Код: (\d{6})/)[1];
    const result = await portal.act(request('auth.verify', { identifier: email, code }));
    return result.body.data.sessionToken;
  }

  const adminToken = await login(member.email);
  const editorToken = await login(editor.email);
  const change = { item_id: 100, name: 'СМЕНА 5/2', time: '09:00-18:00', amount: 0, dept: 'ВСЕ' };
  assert.equal((await portal.act(request('settings.shift.save', change, editorToken))).status, 403);
  assert.equal((await portal.act(request('settings.shift.save', { ...change, name: 'другой ключ' }, adminToken))).status, 409);
  const result = await portal.act(request('settings.shift.save', change, adminToken));
  assert.equal(result.status, 200);
  assert.equal(result.body.data.saved, 'СМЕНА 5/2');
  assert.deepEqual(writes, [{
    upsert: [{ values: ['shift-5-2', 'СМЕНА 5/2', '09:00-18:00', '0', 'ВСЕ', 'Доп. значение'] }],
  }]);
});

test('только роль 1331872 меняет ежедневные отметки табеля вне ТП', async () => {
  const db = openDatabase(':memory:');
  const admin = { id: 11, email: 'admin@example.test' };
  const support = { id: 12, department_name: 'ТП' };
  const assignedToSupport = { id: 13 };
  let editorGranted = true;
  const pyrus = async (method, path, body) => {
    if (path === '/v4/members') return { members: [member, admin, support, assignedToSupport] };
    if (path === '/v4/contacts') return { organizations: [] };
    if (path === '/v4/roles') return { roles: [
      { id: 1331872, member_ids: editorGranted ? [member.id] : [] },
      { id: 1331784, member_ids: [admin.id] },
    ] };
    if (path === '/v4/catalogs/309670') return { items: [{ item_id: 5, values: ['ТП'] }] };
    if (path === '/v4/forms/2470373/register') return { tasks: [{ id: 10, fields: [
      { id: 1, value: { item_id: 5 } },
      { id: 2, value: { id: assignedToSupport.id } },
      { id: 3, value: '2026-11-17T10:00:00Z' },
    ] }] };
    if (path === '/v4/tasks' && method === 'POST' && body.form_id === 2472006) return { task: { id: 900 } };
    throw new Error('Unexpected API: ' + method + ' ' + path);
  };

  const mail = [];
  const dependencies = {
    db, env: { ...env, MANGO_WRITE_ENABLED: 'true' }, pyrus,
    sendMail: async message => { mail.push(message); },
    mango: async () => assert.fail('Табель не обращается к Mango'),
  };
  const portal = createPortal(dependencies);
  async function signIn(person) {
    await portal.act(request('auth.start', { identifier: person.email }));
    const code = mail.at(-1).text.match(/Код: (\d{6})/)[1];
    return (await portal.act(request('auth.verify', { identifier: person.email, code }))).body.data.sessionToken;
  }
  const editorToken = await signIn(member);
  const adminToken = await signIn(admin);
  const mark = { employee_id: member.id, date: '2026-11-17', absence: 'sick', include_in_export: false };
  const save = (row, token = editorToken) => portal.act(request('attendance.save', row, token));
  const list = (month, token = adminToken) => portal.act(request('attendance.list', { month }, token));

  assert.deepEqual((await list('2026-11')).body.data.rows, []);
  assert.equal((await save(mark, adminToken)).status, 403);
  assert.equal((await save({ ...mark, employee_id: support.id })).status, 403);
  assert.equal((await save({ ...mark, employee_id: assignedToSupport.id })).status, 403);
  assert.equal((await save({ ...mark, date: '2026-11-31' })).status, 400);
  assert.equal((await save({ ...mark, include_in_export: 'false' })).status, 400);

  let updates = 0;
  const events = createScheduleEvents(portal);
  const connection = new EventEmitter();
  connection.writeHead = () => {};
  connection.write = message => { if (message.startsWith('event: schedule')) updates++; return true; };
  connection.end = () => connection.emit('close');
  try {
    assert.equal(events.open({ headers: { authorization: 'Bearer ' + adminToken } }, connection), true);
    const initialUpdates = updates;
    assert.equal((await save(mark)).status, 200);
    assert.equal(updates, initialUpdates + 1);
  } finally {
    events.close();
  }

  assert.deepEqual((await list('2026-11')).body.data.rows, [mark]);
  assert.deepEqual((await list('2026-12')).body.data.rows, []);
  const { absence: _, ...flagOnly } = mark;
  assert.equal((await save({ ...flagOnly, include_in_export: true }, adminToken)).status, 403);
  assert.equal((await save({ ...flagOnly, include_in_export: true })).status, 200);
  assert.deepEqual((await list('2026-11')).body.data.rows, [{ ...mark, include_in_export: true }]);
  const restored = { ...mark, absence: 'day_off', include_in_export: true };
  assert.equal((await save(restored)).status, 200);
  const restarted = createPortal(dependencies);
  assert.deepEqual((await restarted.act(request('attendance.list', { month: '2026-11' }, adminToken))).body.data.rows, [restored]);
  editorGranted = false;
  assert.equal((await save(mark)).status, 403);
});
