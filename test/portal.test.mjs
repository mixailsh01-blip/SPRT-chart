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
