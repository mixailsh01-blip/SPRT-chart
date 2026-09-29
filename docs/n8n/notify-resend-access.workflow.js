// Воркфлоу n8n «SPRT: повторная отправка доступа».
// Раз в минуту проверяет форму Pyrus «Уведомления сотрудникам» (form_id 2472006) на новые задачи.
// Поле 3 («Сотрудник», person) задачи — кому повторно отправить доступ к «Графику смен»: письмо с кодом
// входа уходит через тот же action auth.start того же webhook sprt-chart (docs/n8n-api-node.js), что и обычный
// вход — отдельного секрета/логики генерации кода здесь нет. В задачу пишется комментарий с результатом,
// обработанные task_id хранятся в таблице sprt_notify_sent, чтобы не отправлять повторно при следующем опросе.
import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const NOTIFY_TABLE = { __rl: true, mode: 'id', value: 'o44BfvOwwXoDqrsL', cachedResultName: 'sprt_notify_sent' };

const everyMinute = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Каждую минуту',
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
  },
});

const pyrusToken = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Pyrus: токен',
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://accounts.pyrus.com/api/v4/auth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '{\n  "login": "bot@d1494073-ef77-49e6-a97b-8bb08a5eb605",\n  "security_key": "QAILenUEjvaXFNrRI9FzeyjCSmiQsReY~O0RKD-Tn~4ahie3ian0lnafAFpywo6unQPSAHe2IVNY~y5EMHHRTOWVwmDmeptb"\n}',
      options: {},
    },
  },
});

const processedRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1,
  config: {
    name: 'Обработанные: таблица',
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: NOTIFY_TABLE,
      returnAll: true,
    },
    alwaysOutputData: true,
  },
});

const processNode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Найти и отправить новые уведомления',
    parameters: {
      jsCode: `// Форма «Уведомления сотрудникам» (2472006): поле 3 — сотрудник, задачи без обработки — отправляем ему
// письмо повторного входа (через тот же webhook sprt-chart, action auth.start) и запоминаем task_id.
const FORM_ID = 2472006;
const FIELD_PERSON = 3;
const NOTIFY_WEBHOOK = 'https://6009071-by70196.twc1.net/webhook/sprt-chart';

const token = $('Pyrus: токен').first().json.access_token;
if (!token) return [];

const http = (opts) => this.helpers.httpRequest({ json: true, ...opts });
const pyrus = (method, path, body) => {
  const opts = { method, url: \`https://api.pyrus.com\${path}\`, headers: { Authorization: \`Bearer \${token}\` } };
  if (body) opts.body = body;
  return http(opts);
};

const processedIds = new Set($('Обработанные: таблица').all().map((i) => Number(i.json.task_id)).filter((n) => !Number.isNaN(n)));

const reg = await pyrus('GET', \`/v4/forms/\${FORM_ID}/register\`);
const tasks = (reg && reg.tasks) || [];

const results = [];
for (const t of tasks) {
  if (processedIds.has(Number(t.id))) continue;
  const field = (t.fields || []).find((f) => f.id === FIELD_PERSON);
  const person = field && field.value;
  if (!person || !person.id) continue;

  let email = String(person.email || '').trim().toLowerCase();
  if (!email) {
    try {
      const m = await pyrus('GET', \`/v4/members/\${person.id}\`);
      email = String((m && m.email) || '').trim().toLowerCase();
    } catch (e) {
      // сотрудник не найден — пропускаем, но всё равно отметим задачу обработанной, чтобы не зациклиться
    }
  }

  const name = \`\${person.first_name || ''} \${person.last_name || ''}\`.trim();
  let sent = false;
  let error = '';
  if (email) {
    try {
      await http({ method: 'POST', url: NOTIFY_WEBHOOK, body: { action: 'auth.start', payload: { provider: 'email', identifierType: 'email', identifier: email } } });
      sent = true;
    } catch (e) {
      error = e.message || String(e);
    }
  } else {
    error = 'Нет email сотрудника';
  }

  try {
    await pyrus('POST', \`/v4/tasks/\${t.id}/comments\`, {
      text: sent
        ? \`Доступ к «Графику смен» отправлен повторно на \${email}.\`
        : \`Не удалось отправить доступ: \${error}\`,
    });
  } catch (e) {
    // комментарий — не критично, продолжаем
  }

  results.push({ task_id: t.id, email, name, sent_at: new Date().toISOString() });
}

return results.map((r) => ({ json: r }));
`,
    },
  },
});

const markProcessed = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1,
  config: {
    name: 'Обработанные: записать',
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: NOTIFY_TABLE,
      columns: {
        mappingMode: 'defineBelow',
        value: {
          task_id: expr('{{ $json.task_id }}'),
          email: expr('{{ $json.email }}'),
          sent_at: expr('{{ $json.sent_at }}'),
        },
        matchingColumns: [],
        schema: [
          { id: 'task_id', displayName: 'task_id', required: false, defaultMatch: false, display: true, type: 'number', readOnly: false, removed: false },
          { id: 'email', displayName: 'email', required: false, defaultMatch: false, display: true, type: 'string', readOnly: false, removed: false },
          { id: 'sent_at', displayName: 'sent_at', required: false, defaultMatch: false, display: true, type: 'string', readOnly: false, removed: false },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: {},
    },
  },
});

export default workflow('sprt-notify-resend-access', 'SPRT: повторная отправка доступа')
  .add(everyMinute)
  .to(pyrusToken)
  .to(processedRows)
  .to(processNode)
  .to(markProcessed);
