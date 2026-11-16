import { randomUUID } from 'node:crypto';
import { handleAction } from './actions.mjs';
import { createAutomations } from './automations.mjs';

const MINUTE = 60_000;

export function createPortal({ db, pyrus, mango, sendMail, env }) {
  const store = db.read('auth') || {};
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

  async function action(request) {
    const result = await handleAction({
      request, store, pyrus, telephony: db.telephony.all(),
      lunches: db.lunches.all(), schedules: db.schedules.all(),
    });
    db.transaction(() => {
      db.write('auth', { codes: store.codes, sessions: store.sessions, secret: store.secret });
      for (const row of result.telUpdates || []) db.telephony.put(row.task_id, row);
      for (const id of result.body?.data?.deletedIds || []) db.telephony.remove(id);
      for (const row of result.lunchUpdates || []) {
        const id = row.id ?? randomUUID();
        db.lunches.put(id, { ...row, id });
      }
    });
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
    act: request => serialize(() => action(request)),
    tick: () => serialize(() => tick()),
    pollResends: () => serialize(() => jobs.pollResends(action)),
  };
}
