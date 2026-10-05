// n8n Code node «Обеды: список» (между «API» и «Нужно письмо?»): действие lunch.list — обеды всех сотрудников
// за сегодня, видны любому авторизованному. Остальные действия проходят насквозь без изменений.
const crypto = require('crypto');
const items = $input.all();
const req = $('API webhook').first().json;
const action = String((req.body || {}).action || '');
if (action !== 'lunch.list') return items;

const LOCAL_OFFSET_MS = 240 * 60 * 1000; // UTC+4
const now = Date.now();
const store = $getWorkflowStaticData('global');
const reply = (status, body) => [{ json: { status, body, email: null } }];

const h = req.headers || {};
const token = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '').trim();
const key = token && store.secret ? crypto.createHmac('sha256', store.secret).update(`s:${token}`).digest('hex') : '';
const s = key && store.sessions ? store.sessions[key] : null;
if (!s || s.exp < now) return reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Нет сессии или она истекла' } });

const localDay = (ms) => new Date(ms + LOCAL_OFFSET_MS).toISOString().slice(0, 10);
const ms = (v) => (v ? new Date(v).getTime() : NaN);
const iso = (v) => (Number.isNaN(ms(v)) ? null : new Date(ms(v)).toISOString());
const today = localDay(now);

const list = $('Обеды: все').all().map((i) => i.json)
  .filter((r) => r && r.member_id != null && r.member_id !== '' && r.status !== 'cancelled')
  .filter((r) => !Number.isNaN(ms(r.start_utc)) && localDay(ms(r.start_utc)) === today)
  .map((r) => ({
    member_id: Number(r.member_id),
    name: String(r.name || ''),
    dept: String(r.dept || ''),
    status: String(r.status || ''),
    start_utc: iso(r.start_utc),
    end_utc: iso(r.end_utc),
    ended_at: iso(r.ended_at),
    overdue: r.status === 'active' ? now > ms(r.end_utc) : r.overdue === true,
  }))
  .sort((a, b) => ms(a.start_utc) - ms(b.start_utc));

return reply(200, { ok: true, data: { items: list, serverTime: new Date(now).toISOString() } });
