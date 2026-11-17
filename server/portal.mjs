import { randomUUID } from 'node:crypto';
import { handleAction, SCHEDULE_REGISTER_PATH } from './actions.mjs';
import { createAutomations } from './automations.mjs';
import { findSession } from './sessions.mjs';

const MINUTE = 60_000;
const RECENT_UPDATE_MS = 30 * MINUTE;

export function createPortal({ db, pyrus, mango, sendMail, env }) {
  const store = db.read('auth') || {};
  const scheduleListeners = new Set();
  let pending = Promise.resolve();
  let lastSync = 0;
  let requestedSync = 0;
  let lastGroupCheck = 0;
  let groupRequested = false;

  function serialize(work) {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  }

  const jobs = createAutomations({ db, pyrus, mango, sendMail, env });

  async function readWithRecentUpdates(method, path, body) {
    const data = await pyrus(method, path, body);
    if (method !== 'GET' || path !== SCHEDULE_REGISTER_PATH || !Array.isArray(data?.tasks)) return data;
    const tasks = new Map(data.tasks.map(task => [String(task.id), task]));
    const oldest = Date.now() - RECENT_UPDATE_MS;
    for (const update of db.schedule_updates.all()) {
      if (update.at < oldest) continue;
      const id = String(update.id);
      if (!update.task) {
        tasks.delete(id);
        continue;
      }
      const registered = tasks.get(id);
      const newerInRegister = registered?.last_modified_date &&
        (!update.task.last_modified_date || Date.parse(registered.last_modified_date) > Date.parse(update.task.last_modified_date));
      if (!newerInRegister) tasks.set(id, update.task);
    }
    return { ...data, tasks: [...tasks.values()] };
  }

  async function action(request) {
    const result = await handleAction({
      request, store, pyrus: readWithRecentUpdates, telephony: db.telephony.all(),
      lunches: db.lunches.all(), schedules: db.schedules.all(), attendance: db.attendance,
    });
    const resultData = result.body?.data;
    const source = request.body.action;
    const scheduleChanged = (source === 'schedule.save' &&
      Boolean(resultData?.created || resultData?.edited || resultData?.deleted)) ||
      (source === 'schedule.swap' && resultData?.swapped === true);
    db.transaction(() => {
      db.write('auth', { codes: store.codes, sessions: store.sessions, secret: store.secret });
      for (const row of result.telUpdates || []) db.telephony.put(row.task_id, row);
      for (const id of result.body?.data?.deletedIds || []) db.telephony.remove(id);
      if (scheduleChanged) {
        const now = Date.now();
        for (const update of db.schedule_updates.all()) {
          if (update.at < now - RECENT_UPDATE_MS) db.schedule_updates.remove(update.id);
        }
        for (const task of resultData.tasks || []) {
          if (task?.id != null) db.schedule_updates.put(task.id, { id: task.id, task, at: now });
        }
        for (const id of resultData.deletedIds || []) {
          db.schedule_updates.put(id, { id, at: now });
        }
      }
      if (result.attendanceUpdate) {
        const row = result.attendanceUpdate;
        db.attendance.put(row.date + ':' + row.employee_id, row);
      }
      for (const row of result.lunchUpdates || []) {
        const id = row.id ?? randomUUID();
        db.lunches.put(id, { ...row, id });
      }
    });
    if (scheduleChanged || result.attendanceUpdate) for (const listener of scheduleListeners) listener();
    if (result.mangoSync || result.telUpdates?.length || result.body?.data?.deletedIds?.length) {
      const due = Date.now() + 10_000;
      requestedSync = requestedSync ? Math.min(requestedSync, due) : due;
    }
    if (result.lunchUpdates?.length) groupRequested = true;

    if (result.email) {
      const { to, code, link, name } = result.email;
      const login = new URL('/', env.PUBLIC_URL);
      login.searchParams.set('li', link);
      const deliveries = await Promise.allSettled([
        sendMail({
          to, subject: 'Код входа в «График смен»',
          text: 'Здравствуйте, ' + name + '!\n\nКод: ' + code +
            '\nСсылка для входа: ' + login.href + '\n\nКод и ссылка действуют 5 минут.',
        }),
        jobs.notifyLogin(result.pyrusNotify),
      ]);
      if (deliveries[0].status === 'rejected') console.error('Не удалось отправить код по почте');
      if (deliveries[1].status === 'rejected') console.error('Не удалось создать уведомление о входе в Pyrus');
      if (deliveries.every(delivery => delivery.status === 'rejected')) {
        delete store.codes[to];
        db.write('auth', { codes: store.codes, sessions: store.sessions, secret: store.secret });
        return { status: 502, body: { ok: false, error: { code: 'DELIVERY_FAILED', message: 'Не удалось отправить код входа' } } };
      }
    }

    for (const message of result.notify || []) {
      try {
        await sendMail({ to: message.to, subject: message.subject, html: message.html });
      } catch { console.error('Не удалось отправить письмо об обмене сменами'); }
    }

    return { status: result.status, body: result.body };
  }

  async function tick(now = Date.now()) {
    if (await jobs.tickLunches(now)) groupRequested = true;
    if (now - lastSync >= 10 * MINUTE || (requestedSync && requestedSync <= now)) {
      await jobs.sync(now);
      lastSync = now;
      requestedSync = 0;
      groupRequested = true;
    }
    if (lastSync && (groupRequested || now - lastGroupCheck >= MINUTE)) {
      await jobs.updateGroups(now);
      lastGroupCheck = now;
      groupRequested = false;
    }
  }

  return {
    isAuthenticated: headers => Boolean(findSession(store, headers)),
    onScheduleChange(listener) {
      scheduleListeners.add(listener);
      return () => scheduleListeners.delete(listener);
    },
    act: request => serialize(() => action(request)),
    tick: () => serialize(() => tick()),
    pollResends: () => serialize(() => jobs.pollResends(action)),
  };
}
