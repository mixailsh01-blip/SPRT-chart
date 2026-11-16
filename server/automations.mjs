import { departmentRoster, mangoGroups, scheduleRows } from './routing.mjs';

const NOTIFY_FORM = 2472006;
const LOGIN_NOTIFICATION = 1;
const LUNCH_OVERDUE_NOTIFICATION = 3;
const SHIFT_FORM = 2470373;
const MINUTE = 60_000;
const localTime = value => new Date(Date.parse(value) + 240 * MINUTE).toISOString().slice(11, 16);

function replace(table, rows, key) {
  table.clear();
  for (const row of rows) table.put(row[key], row);
}

function requireList(data, key) {
  if (!Array.isArray(data[key])) throw new Error('В ответе интеграции отсутствует список ' + key);
  return data[key];
}

export function createAutomations({ db, pyrus, mango, sendMail, env }) {
  let mangoUsersFetched = 0;
  let fallbackSignature;
  let lastGroupSignature;
  const mangoConfigured = Boolean(env.MANGO_API_KEY && env.MANGO_API_SALT);

  async function sync(now = Date.now()) {
    const [membersResponse, registry, rolesResponse] = await Promise.all([
      pyrus('GET', '/v4/members'),
      pyrus('GET', '/v4/forms/' + SHIFT_FORM + '/register'),
      pyrus('GET', '/v4/roles'),
    ]);
    const members = requireList(membersResponse, 'members');
    const tasks = requireList(registry, 'tasks');
    const roles = requireList(rolesResponse, 'roles');
    let mangoUsers = db.mango_users.all();
    if (mangoConfigured && now - mangoUsersFetched >= 60 * MINUTE) {
      const data = await mango('config/users/request', {
        ext_fields: ['general.user_id', 'general.use_status', 'general.use_cc_numbers', 'general.mobile',
          'general.login', 'general.email', 'telephony.outgoingline', 'telephony.line_id',
          'telephony.trunk_number_id', 'telephony.dial_alg', 'telephony.numbers.schedule'],
      });
      mangoUsers = requireList(data, 'users').filter(user => user.general?.user_id).map(user => ({
        user_id: String(user.general.user_id),
        user_name: user.general.name,
        number: String(user.telephony?.extension ?? ''),
      }));
      if (!mangoUsers.length) throw new Error('Mango вернул пустой список сотрудников');
      mangoUsersFetched = now;
    }

    const schedules = scheduleRows({ members, tasks, telephony: db.telephony.all(), now });
    const rosterRows = departmentRoster({ members, roles, mango: mangoUsers });
    db.transaction(() => {
      replace(db.schedules, schedules, 'task_id');
      replace(db.mango_users, mangoUsers, 'user_id');
      replace(db.roster, rosterRows, 'key');
    });

  }

  async function updateGroups(now) {
    if (env.MANGO_WRITE_ENABLED !== 'true') return;
    const mangoUsers = db.mango_users.all();
    if (!mangoUsers.length) throw new Error('Список сотрудников Mango пуст');
    const groups = mangoGroups({
      schedules: db.schedules.all(), mangoUsers, lunches: db.lunches.all(),
      rosterRows: db.roster.all(), groupId: env.MANGO_GROUP_ID || '20624288', now,
    });
    for (const group of groups) {
      const signature = JSON.stringify(group.payload);
      if (group.isFallback && !group.operatorCount && !db.roster.all().length) {
        throw new Error('Резервный состав Mango отсутствует');
      }
      if (signature !== lastGroupSignature || now - (db.read('groupUpdatedAt') || 0) >= 10 * MINUTE) {
        await mango('group/update', group.payload);
        lastGroupSignature = signature;
        db.write('groupUpdatedAt', now);
      }
      if (group.isFallback && signature !== fallbackSignature && env.MANGO_ALERT_EMAIL) {
        await sendMail({
          to: env.MANGO_ALERT_EMAIL,
          subject: 'Mango: резервный состав группы ' + group.deptName,
          text: 'В рабочее время нет сотрудников на линии. Резерв: ' +
            (group.fallbackNames.join(', ') || 'пусто') + '. На обеде: ' +
            (group.lunchNames.join(', ') || 'никого') + '.',
        });
      }
      fallbackSignature = group.isFallback ? signature : undefined;
    }
  }

  async function tickLunches(now = Date.now()) {
    const lunches = db.lunches.all();
    const starting = lunches.filter(row =>
      row.status === 'scheduled' && Date.parse(row.start_utc) <= now);
    const expired = [...lunches.filter(row => row.status === 'active'), ...starting]
      .filter(row => row.overdue !== true && Date.parse(row.end_utc) <= now);
    if (!starting.length && !expired.length) return false;

    db.transaction(() => {
      for (const row of starting) db.lunches.put(row.id, { ...row, status: 'active' });
      for (const row of expired) db.lunches.put(row.id, { ...row, status: 'active', overdue: true });
    });

    for (const row of expired) {
      const start = localTime(row.start_utc);
      const end = localTime(row.end_utc);
      const managerText = row.name + (row.dept ? ' (' + row.dept + ')' : '') +
        ' не завершил обед к ' + end + ' (начало в ' + start + '). Сотрудник вернётся в группу Mango после нажатия «В линию».';
      const employeeText = 'Время обеда истекло в ' + end + '. Когда вернётесь, нажмите «В линию» в графике смен.';
      const deliveries = [
        { channel: 'Pyrus (руководитель)', send: () => notifyLunchOverdue(1195524, managerText) },
      ];
      if (Number(row.member_id)) {
        deliveries.push({ channel: 'Pyrus (сотрудник)', send: () => notifyLunchOverdue(Number(row.member_id), employeeText) });
      }
      if (env.LUNCH_ALERT_EMAIL) {
        deliveries.push({
          channel: 'SMTP',
          send: () => sendMail({ to: env.LUNCH_ALERT_EMAIL, subject: 'Обед просрочен: ' + row.name, text: managerText }),
        });
      }
      await Promise.all(deliveries.map(async ({ channel, send }) => {
        try { await send(); }
        catch { console.error('Не удалось отправить уведомление о просроченном обеде через ' + channel); }
      }));
    }
    return starting.length > 0;
  }

  async function notifyLunchOverdue(memberId, text) {
    await pyrus('POST', '/v4/tasks', {
      form_id: NOTIFY_FORM,
      fields: [
        { id: 8, value: { choice_ids: [LUNCH_OVERDUE_NOTIFICATION] } },
        { id: 3, value: { id: memberId } },
        { id: 1, value: text },
      ],
    });
  }

  async function notifyLogin({ memberId, email, code, link }) {
    const data = await pyrus('POST', '/v4/tasks', {
      form_id: NOTIFY_FORM,
      fields: [
        { id: 8, value: { choice_ids: [LOGIN_NOTIFICATION] } },
        { id: 6, value: email }, { id: 9, value: link }, { id: 3, value: { id: memberId } },
        { id: 1, value: 'Авторизация в «График смен». Код: ' + code +
          '. Код и ссылка действуют 5 минут и работают один раз.' },
      ],
    });
    const id = data.task?.id;
    if (id) db.notifications.put(id, { task_id: id, email });
  }

  async function pollResends(runAction) {
    const registry = await pyrus('GET', '/v4/forms/' + NOTIFY_FORM + '/register');
    const tasks = requireList(registry, 'tasks');
    if (!db.read('resendInitialized')) {
      db.transaction(() => {
        for (const task of tasks) db.notifications.put(task.id, { task_id: task.id });
        db.write('resendInitialized', true);
      });
      return;
    }
    for (const task of tasks) {
      if (db.notifications.has(task.id)) continue;
      const field = id => task.fields?.find(value => value.id === id)?.value;
      const types = field(8)?.choice_ids?.map(Number) || [];
      if (types.includes(LOGIN_NOTIFICATION) || types.includes(LUNCH_OVERDUE_NOTIFICATION)) continue;
      const person = field(3);
      if (!person?.id) continue;
      let email = person.email;
      if (!email) {
        const data = await pyrus('GET', '/v4/members/' + Number(person.id));
        email = data.email || data.member?.email;
      }
      const result = email && await runAction({ headers: {}, body: { action: 'auth.start', payload: { identifier: email } } });
      if (result?.status === 429 || result?.status >= 500) continue;
      db.notifications.put(task.id, { task_id: task.id, email });
      try {
        await pyrus('POST', '/v4/tasks/' + Number(task.id) + '/comments', {
          text: result?.status === 200 ? 'Доступ к «График смен» отправлен повторно.' :
            'Не удалось отправить доступ к «График смен». Проверьте email сотрудника.',
        });
      } catch { console.error('Не удалось добавить комментарий о повторной отправке в Pyrus'); }
    }
  }

  return { sync, updateGroups, tickLunches, notifyLogin, pollResends };
}
