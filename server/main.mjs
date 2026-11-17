import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.mjs';
import { createMailer, createMango, createPyrus } from './integrations.mjs';
import { createPortal } from './portal.mjs';
import { renderAttendancePdf } from './attendance-report.mjs';
import { createScheduleEvents } from './schedule-events.mjs';

const env = process.env;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticTypes = new Map([
  ['.html', 'text/html'], ['.js', 'text/javascript'],
  ['.css', 'text/css'], ['.json', 'application/json'],
]);
const required = ['PUBLIC_URL', 'PYRUS_LOGIN', 'PYRUS_SECURITY_KEY', 'SMTP_HOST', 'SMTP_FROM'];
if (env.MANGO_WRITE_ENABLED === 'true') required.push('MANGO_API_KEY', 'MANGO_API_SALT');
if (env.SMTP_USER) required.push('SMTP_PASSWORD');
const missing = required.filter(key => !env[key]);
if (missing.length) throw new Error('Не заданы переменные окружения: ' + missing.join(', '));
const publicUrl = new URL(env.PUBLIC_URL);
if (publicUrl.protocol !== 'https:' && publicUrl.hostname !== 'localhost') {
  throw new Error('PUBLIC_URL должен использовать HTTPS');
}
const db = openDatabase(env.SQLITE_PATH || 'sprt.sqlite');
const portal = createPortal({
  db, env, pyrus: createPyrus(env), mango: createMango(env), sendMail: createMailer(env),
});
const scheduleEvents = createScheduleEvents(portal);
const apiError = (code, message) => ({ ok: false, error: { code, message } });

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error(), { status: 413 });
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  return input;
}

async function serve(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/healthz') return send(res, 200, { ok: true });
  if (path === '/api/sprt-chart/events') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, apiError('METHOD_NOT_ALLOWED', 'Используйте GET'));
    }
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) {
      return send(res, 403, apiError('FORBIDDEN_ORIGIN', 'Недопустимый источник запроса'));
    }
    if (!scheduleEvents.open(req, res)) {
      return send(res, 401, apiError('UNAUTHORIZED', 'Нет сессии или она истекла'));
    }
    return;
  }
  if (path === '/api/sprt-chart') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, apiError('METHOD_NOT_ALLOWED', 'Используйте POST'));
    }
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) {
      return send(res, 403, apiError('FORBIDDEN_ORIGIN', 'Недопустимый источник запроса'));
    }
    let body;
    try { body = await readBody(req); }
    catch (error) {
      return send(res, error.status || 400, apiError('INVALID_BODY', 'Некорректный JSON или слишком большой запрос'));
    }
    const { status, body: result } = await portal.act({ body, headers: req.headers });
    if (body.action === 'attendance.export' && status === 200) {
      const pdf = await renderAttendancePdf(result.data);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="attendance-' + result.data.period + '-' + result.data.month + '.pdf"',
        'Cache-Control': 'no-store',
      });
      return res.end(pdf);
    }
    return send(res, status, result);
  }

  const filename = path === '/' ? '/index.html' : path;
  const extension = extname(filename);
  const isStatic = filename === '/index.html' || filename === '/config.json' ||
    /^\/(?:js|css)\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/i.test(filename);
  if (!['GET', 'HEAD'].includes(req.method) || !isStatic || !staticTypes.has(extension)) {
    return send(res, 404, apiError('NOT_FOUND', 'Страница не найдена'));
  }
  const target = resolve(root, '.' + filename);
  if (!target.startsWith(root + '/')) return send(res, 404, apiError('NOT_FOUND', 'Страница не найдена'));
  const content = await readFile(target).catch(error => {
    if (['ENOENT', 'EISDIR'].includes(error.code)) return null;
    throw error;
  });
  if (!content) return send(res, 404, apiError('NOT_FOUND', 'Страница не найдена'));
  res.writeHead(200, {
    'Content-Type': staticTypes.get(extension) + '; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

const server = createServer((req, res) => {
  serve(req, res).catch(() => {
    console.error('Ошибка обработки HTTP-запроса');
    if (!res.headersSent) send(res, 500, apiError('INTERNAL_ERROR', 'Внутренняя ошибка сервера'));
    else res.destroy();
  });
});
server.listen(Number(env.PORT || 8080), '0.0.0.0', () => console.info('Портал запущен'));
let syncing = false;
function tick() {
  if (syncing) return;
  syncing = true;
  portal.tick().catch(error => console.error('Ошибка синхронизации:', error.message)).finally(() => { syncing = false; });
}
tick();
const syncTimer = setInterval(tick, 5000);

let polling = false;
function poll() {
  if (polling) return;
  polling = true;
  portal.pollResends().catch(error => console.error('Ошибка опроса Pyrus:', error.message)).finally(() => { polling = false; });
}
const resendTimer = env.PYRUS_RESEND_ENABLED === 'true' ? setInterval(poll, 60_000) : null;
if (resendTimer) poll();
process.on('SIGTERM', () => {
  clearInterval(syncTimer);
  if (resendTimer) clearInterval(resendTimer);
  scheduleEvents.close();
  server.close();
});
