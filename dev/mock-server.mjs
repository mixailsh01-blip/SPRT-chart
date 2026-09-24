// dev/mock-server.mjs — локальный мок бэкенда по docs/API_CONTRACT.md.
// Запуск: node dev/mock-server.mjs  →  http://localhost:8787
// Отдаёт статику проекта и эмулирует POST /api (auth.*, pyrus.request, schedule.save)
// на фейковых данных. Код входа всегда 123456.
// config.json при этом подменяется: api.baseUrl = http://localhost:8787/api

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const cfg = JSON.parse(await readFile(join(ROOT, "config.json"), "utf8"));

const F = cfg.pyrus.fields.schedule;
const V = cfg.pyrus.fields.vacations;
const DEPT = { TP: 900001, PO: 900002 };
const SHIFTS = [
  { item_id: 800001, values: ["День", "09:00-18:00", "3000", "ТП, ПО"] },
  { item_id: 800002, values: ["Ночь", "21:00-09:00", "4500", "ТП"] },
  { item_id: 800003, values: ["ВЫХ", "", "0", ""] },
];
const members = [
  { id: 1, first_name: "Иван", last_name: "Петров", email: "petrov@example.com", phone: "79000000001", department_id: 10, birth_date: { day: 5, month: 1 } },
  { id: 2, first_name: "Анна", last_name: "Смирнова", email: "smirnova@example.com", phone: "79000000002", department_id: 10 },
  { id: 3, first_name: "Олег", last_name: "Кузнецов", email: "kuznetsov@example.com", phone: "79000000003", department_id: 20 },
];
const ROLES_BY_MEMBER = { 1: [1329637], 2: [], 3: [1329638] };

let nextTaskId = 5000;
const tasks = [];
const now = new Date();
function addShift(empId, dept, day, shiftIdx, startUtcHour, duration) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, startUtcHour, 0, 0));
  tasks.push({
    id: nextTaskId++,
    fields: [
      { id: F.department, type: "catalog", value: { item_id: DEPT[dept], values: [dept === "TP" ? "ТП" : "ПО"] } },
      { id: F.person, type: "person", value: { id: empId } },
      { id: F.due, type: "due_date_time", value: start.toISOString(), duration },
      { id: F.amount, type: "money", value: Number(SHIFTS[shiftIdx].values[2]) },
      { id: F.template, type: "catalog", value: { item_id: SHIFTS[shiftIdx].item_id, values: SHIFTS[shiftIdx].values } },
    ],
  });
}
for (let d = 1; d <= 10; d++) addShift(1, "TP", d, 0, 5, 540); // 09:00 Самара = 05:00 UTC
for (let d = 3; d <= 8; d++) addShift(2, "TP", d, 1, 17, 720);
for (let d = 2; d <= 12; d += 2) addShift(3, "PO", d, 0, 5, 540);

const vacations = [
  {
    id: 7001,
    fields: [
      { id: V.period, type: "due_date", value: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-20`, duration: 5 * 1440 },
      { id: V.year, type: "text", value: String(now.getUTCFullYear()) },
      { id: V.person, type: "person", value: { id: 2 } },
      { id: V.days, type: "number", value: 5 },
    ],
  },
];

const sessions = new Map();
const WHITELIST = [
  /^\/v4\/members$/,
  /^\/v4\/members\/\d+$/,
  /^\/v4\/roles$/,
  new RegExp(`^/v4/catalogs/(${cfg.pyrus.catalogs.shifts}|${cfg.pyrus.catalogs.departments})$`),
  new RegExp(`^/v4/forms/(${cfg.pyrus.forms.schedule}|${cfg.pyrus.forms.vacations})/register`),
];

function pyrus(path) {
  if (path === "/v4/members") return { members };
  if (path === "/v4/roles") return { roles: [{ id: 1329812, name: "Сотрудники ТП", member_ids: [1, 2] }, { id: 1329638, name: "ПО", member_ids: [3] }] };
  if (/^\/v4\/members\/\d+$/.test(path)) {
    const id = Number(path.split("/").pop());
    return { ...members.find((m) => m.id === id), roles: ROLES_BY_MEMBER[id] || [] };
  }
  if (path === `/v4/catalogs/${cfg.pyrus.catalogs.shifts}`)
    return { catalog_headers: [{ name: "Название смены" }, { name: "время смены" }, { name: "Сумма за смену" }, { name: "Подразделение" }], items: SHIFTS };
  if (path === `/v4/catalogs/${cfg.pyrus.catalogs.departments}`)
    return { catalog_headers: [{ name: "Подразделения компании" }], items: [{ item_id: DEPT.TP, values: ["ТП"] }, { item_id: DEPT.PO, values: ["ПО"] }] };
  if (path.startsWith(`/v4/forms/${cfg.pyrus.forms.schedule}/register`)) return { tasks };
  if (path.startsWith(`/v4/forms/${cfg.pyrus.forms.vacations}/register`)) return { tasks: vacations };
  return null;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
const ok = (res, data) => send(res, 200, { ok: true, data });
const fail = (res, status, code, message, extra = {}) => send(res, status, { ok: false, error: { code, message, ...extra } });

async function handleApi(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { action, payload = {} } = JSON.parse(body || "{}");
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);

  if (action === "auth.start") {
    const member = members.find((m) => m.phone === payload.identifier || m.email === payload.identifier);
    if (!member) return fail(res, 404, "NOT_FOUND", "Сотрудник не найден");
    return ok(res, { challengeId: `ch-${member.id}`, ttlSec: 300 });
  }
  if (action === "auth.verify") {
    const member = members.find((m) => m.phone === payload.identifier || m.email === payload.identifier);
    if (!member || payload.code !== "123456") return fail(res, 400, "INVALID_CODE", "Неверный код");
    const sessionToken = `mock-${member.id}-${Date.now()}`;
    sessions.set(sessionToken, member.id);
    return ok(res, { sessionToken, user: { id: member.id, name: `${member.last_name} ${member.first_name}`, login: payload.identifier }, roles: ROLES_BY_MEMBER[member.id] });
  }
  if (!session) return fail(res, 401, "UNAUTHORIZED", "Нет сессии");
  if (action === "auth.me") {
    const m = members.find((x) => x.id === session);
    return ok(res, { user: { id: m.id, name: `${m.last_name} ${m.first_name}` }, roles: ROLES_BY_MEMBER[m.id] });
  }
  if (action === "auth.logout") {
    sessions.delete(token);
    return ok(res, {});
  }
  if (action === "pyrus.request") {
    const path = String(payload.path || "").split("?")[0];
    if ((payload.method || "GET") !== "GET" || !WHITELIST.some((re) => re.test(path)))
      return fail(res, 403, "FORBIDDEN_PATH", `Путь не разрешён: ${payload.method} ${path}`);
    return ok(res, pyrus(path));
  }
  if (action === "schedule.save") {
    console.log("schedule.save", JSON.stringify(payload, null, 2));
    return ok(res, { created: payload.changes.create.task.length, edited: payload.changes.edit.task.length, deleted: payload.changes.deleted.task.length });
  }
  return fail(res, 400, "UNKNOWN_ACTION", `Неизвестный action: ${action}`);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/api" && req.method === "POST") return await handleApi(req, res);
    if (url.pathname === "/config.json") {
      return send(res, 200, { ...cfg, api: { ...cfg.api, baseUrl: `http://localhost:${PORT}/api` } });
    }
    const file = normalize(join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(ROOT)) return send(res, 403, {});
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    send(res, err.code === "ENOENT" ? 404 : 500, { error: String(err.message) });
  }
}).listen(PORT, () => console.log(`Mock: http://localhost:${PORT}  (код входа 123456, телефоны 79000000001..3)`));
