// Воркфлоу n8n «SPRT: обеды — возврат в линию».
// Раз в минуту, две независимые ветки:
// 1) обеды из sprt_lunch со status = active и истёкшим end_utc закрываются (status = auto, overdue = true),
//    руководителю уходит письмо, группа Манго пересобирается (сотрудник снова в линии);
// 2) запланированные обеды (status = scheduled), чьё start_utc наступило, переводятся в active —
//    сотрудник убирается из группы Манго ровно в назначенное время.
import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const MANAGER_EMAILS = 'm.demetiev@sprt-service.ru'; // руководитель(и) — через запятую
const LUNCH_TABLE = { __rl: true, mode: 'id', value: 'JugiHxYKjZsK9R2t', cachedResultName: 'sprt_lunch' };
const MANGO_SYNC_URL = 'https://6009071-by70196.twc1.net/webhook/sprt-mango-sync-919f9cf55c361996';

// Единый брендинг всех писем SPRT (тот же shell — в «Письмо с кодом» / «Уведомление: письмо» узла «API»
// воркфлоу SPRT-chart API). Между header/footer подставляется контент письма.
const EMAIL_SHELL_HEADER = `<div style="font-family:Arial,Helvetica,sans-serif;background:#03202F;padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#0B2A3B;border-radius:16px;overflow:hidden;border:1px solid #16374A">
<tr><td style="padding:28px 32px 20px;text-align:center">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 14px"><tr>
<td style="width:34px;height:34px;background:#ffffff;border-radius:8px;text-align:center;vertical-align:middle;font-weight:700;font-size:18px;color:#073E59;font-family:Arial,sans-serif">S</td>
<td style="width:8px"></td>
<td style="width:34px;height:34px;background:#ffffff;border-radius:8px;text-align:center;vertical-align:middle;font-weight:700;font-size:18px;color:#073E59;font-family:Arial,sans-serif">P</td>
<td style="width:8px"></td>
<td style="width:34px;height:34px;background:#ffffff;border-radius:8px;text-align:center;vertical-align:middle;font-weight:700;font-size:18px;color:#073E59;font-family:Arial,sans-serif">R</td>
<td style="width:8px"></td>
<td style="width:34px;height:34px;background:#ffffff;border-radius:8px;text-align:center;vertical-align:middle;font-weight:700;font-size:18px;color:#073E59;font-family:Arial,sans-serif">T</td>
</tr></table>
<div style="color:#8FA9B8;font-size:12px">Надёжная поддержка Вашего бизнеса</div>
<div style="color:#ffffff;font-size:15px;font-weight:600;margin-top:2px">График смен</div>
</td></tr>
<tr><td style="padding:4px 32px 28px">
<div style="background:#F2F6F8;border-radius:14px;padding:24px;color:#0B1F2A;font-size:14px;line-height:1.5">`;
const EMAIL_SHELL_FOOTER = `</div>
</td></tr>
</table>
</div>`;

const everyMinute = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Каждую минуту',
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
  },
});

const activeLunches = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1,
  config: {
    name: 'Обеды: активные',
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: LUNCH_TABLE,
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'status', condition: 'eq', keyValue: 'active' }] },
      returnAll: true,
    },
  },
});

const expired = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Обеды: время вышло',
    parameters: {
      jsCode: `// Обеды, у которых прошёл час (end_utc <= сейчас). Остальные — ждут дальше.
const now = Date.now();
const OFF = 240 * 60000; // UTC+4 — только для текста письма
const hhmm = (iso) => new Date(new Date(iso).getTime() + OFF).toISOString().slice(11, 16);
return $input.all()
  .map((i) => i.json)
  .filter((r) => r && r.id != null && r.status === 'active' && new Date(r.end_utc).getTime() <= now)
  .map((r) => ({ json: {
    row_id: r.id,
    name: r.name || '',
    email: r.email || '',
    dept: r.dept || '',
    start_local: hhmm(r.start_utc),
    end_local: hhmm(r.end_utc),
    ended_at: new Date(now).toISOString(),
  } }));
`,
    },
  },
});

const closeLunch = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1,
  config: {
    name: 'Обед: вернуть в линию',
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: LUNCH_TABLE,
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: expr('{{ $json.row_id }}') }] },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          status: 'auto',
          ended_at: expr('{{ $json.ended_at }}'),
          overdue: true,
        },
        matchingColumns: [],
        schema: [
          { id: 'status', displayName: 'status', required: false, defaultMatch: false, display: true, type: 'string', readOnly: false, removed: false },
          { id: 'ended_at', displayName: 'ended_at', required: false, defaultMatch: false, display: true, type: 'string', readOnly: false, removed: false },
          { id: 'overdue', displayName: 'overdue', required: false, defaultMatch: false, display: true, type: 'boolean', readOnly: false, removed: false },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: {},
    },
  },
});

const scheduledLunches = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1,
  config: {
    name: 'Обеды: запланированные',
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: LUNCH_TABLE,
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'status', condition: 'eq', keyValue: 'scheduled' }] },
      returnAll: true,
    },
  },
});

const startingNow = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Обеды: время начать',
    parameters: {
      jsCode: `// Запланированные обеды, чьё время наступило (start_utc <= сейчас) — переводим в active.
const now = Date.now();
return $input.all()
  .map((i) => i.json)
  .filter((r) => r && r.id != null && r.status === 'scheduled' && new Date(r.start_utc).getTime() <= now)
  .map((r) => ({ json: { row_id: r.id } }));
`,
    },
  },
});

const startScheduledLunch = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1,
  config: {
    name: 'Обед: начать (время пришло)',
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: LUNCH_TABLE,
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: expr('{{ $json.row_id }}') }] },
      columns: {
        mappingMode: 'defineBelow',
        value: { status: 'active' },
        matchingColumns: [],
        schema: [
          { id: 'status', displayName: 'status', required: false, defaultMatch: false, display: true, type: 'string', readOnly: false, removed: false },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: {},
    },
  },
});

const mangoSync = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Манго: пересобрать группу',
    executeOnce: true,
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: MANGO_SYNC_URL,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr("{{ JSON.stringify({ source: 'sprt-lunch-timer', at: $now.toISO() }) }}"),
      options: { timeout: 10000 },
    },
  },
});

const managerEmail = node({
  type: 'n8n-nodes-base.emailSend',
  version: 2.1,
  config: {
    name: 'Письмо руководителю',
    onError: 'continueRegularOutput',
    credentials: { smtp: { id: 'A2Hme5DJw4Mg25WT', name: 'SMTP account' } },
    parameters: {
      fromEmail: 'SPRT График смен <m.demetiev@sprt-service.ru>',
      toEmail: MANAGER_EMAILS,
      subject: expr('⏰ Обед просрочен: {{ $json.name }}'),
      html: expr(`${EMAIL_SHELL_HEADER}
<p><b>{{ $json.name }}</b>{{ $json.dept ? ' (' + $json.dept + ')' : '' }} ушёл на обед в {{ $json.start_local }} и не вернулся в линию сам к {{ $json.end_local }}.</p>
<p style="margin:0">Сотрудник автоматически возвращён в группу Mango.</p>
${EMAIL_SHELL_FOOTER}`),
      options: { appendAttribution: false },
    },
  },
});

export default workflow('sprt-lunch-timer', 'SPRT: обеды — возврат в линию')
  .add(everyMinute)
  .to(activeLunches)
  .to(expired)
  .to(closeLunch.to(mangoSync))
  .add(expired)
  .to(managerEmail)
  .add(everyMinute)
  .to(scheduledLunches)
  .to(startingNow)
  .to(startScheduledLunch.to(mangoSync));
