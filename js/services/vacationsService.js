import { cached, peekCache, invalidateByPrefix } from "../cache/requestCache.js";
import { unwrapPyrusData } from "../api/pyrusClient.js";

const DEFAULT_VACATIONS_TTL_MS = 3 * 60 * 60 * 1000; // 3h
// Реестр Pyrus обновляется с задержкой: созданные/удалённые с сайта отпуска
// держим поверх реестра, пока он не догонит.
const RECENT_WRITES_TTL_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseMonthKey(monthKey) {
  const [yearStr, monthStr] = String(monthKey).split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) {
    throw new Error(`Invalid monthKey: ${monthKey}`);
  }
  return { year, monthIndex };
}

export function createVacationsService({
  pyrusClient,
  formId,
  fieldIds,
  timezoneOffsetMin,
  ttlMs = DEFAULT_VACATIONS_TTL_MS,
} = {}) {
  if (!pyrusClient || typeof pyrusClient.pyrusRequest !== "function") {
    throw new Error("pyrusClient is required for vacationsService");
  }

  const recentUpserts = new Map(); // task_id -> { task, at }
  const recentDeletes = new Map(); // task_id -> at

  function withRecentWrites(tasks) {
    const border = Date.now() - RECENT_WRITES_TTL_MS;
    for (const [id, v] of recentUpserts) if (v.at < border) recentUpserts.delete(id);
    for (const [id, at] of recentDeletes) if (at < border) recentDeletes.delete(id);
    if (!recentUpserts.size && !recentDeletes.size) return tasks;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const [id, { task }] of recentUpserts) if (!byId.has(id)) byId.set(id, task);
    for (const id of recentDeletes.keys()) byId.delete(id);
    return [...byId.values()];
  }

  function invalidateAll() {
    invalidateByPrefix("pyrus:vacations:");
  }

  // Результат vacation.create / vacation.delete — показываем сразу, не дожидаясь реестра
  function applyCreated(task) {
    if (!task || task.id == null) return;
    recentUpserts.set(task.id, { task, at: Date.now() });
    recentDeletes.delete(task.id);
    invalidateAll();
  }

  function applyDeleted(taskId) {
    if (taskId == null) return;
    recentDeletes.set(taskId, Date.now());
    recentUpserts.delete(taskId);
    invalidateAll();
  }

  async function getVacationsForMonth(monthKey, { force } = {}) {
    const { year, monthIndex } = parseMonthKey(monthKey);

    return cached(
      `pyrus:vacations:${monthKey}`,
      { ttlMs, force },
      async () => {
        // Реестр отпусков один на все месяцы — запрашиваем его один раз (кеш 90 с),
        // а по месяцам только разбираем.
        const raw = await cached("pyrus:vacations:register", { ttlMs: 90_000 }, () =>
          pyrusClient.pyrusRequest(`/v4/forms/${formId}/register`, { method: "GET" })
        );
        const data = unwrapPyrusData(raw);
        const wrapper = Array.isArray(data) ? data[0] : data;
        const tasks = withRecentWrites((wrapper && wrapper.tasks) || []);

        const vacationsByEmployee = Object.create(null);
        const offsetMs = Number(timezoneOffsetMin || 0) * 60 * 1000;

        const monthStartShiftedMs = Date.UTC(year, monthIndex, 1, 0, 0, 0, 0);
        const monthEndShiftedMs = Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0);
        const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

        const fmt = (shiftedMs) => {
          const d = new Date(shiftedMs);
          const dd = String(d.getUTCDate()).padStart(2, "0");
          const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
          const yy = d.getUTCFullYear();
          return `${dd}.${mm}.${yy}`;
        };

        const isMidnight = (shiftedMs) => {
          const d = new Date(shiftedMs);
          return (
            d.getUTCHours() === 0 &&
            d.getUTCMinutes() === 0 &&
            d.getUTCSeconds() === 0 &&
            d.getUTCMilliseconds() === 0
          );
        };

        for (const task of tasks) {
          const fields = task.fields || [];
          const personField = fields.find(
            (f) => f && f.id === fieldIds?.person && f.type === "person"
          );
          // "Дата и период" (due_date) или "Дата, время и период" (due_date_time)
          const periodField = fields.find(
            (f) =>
              f &&
              f.id === fieldIds?.period &&
              (f.type === "due_date_time" || f.type === "due_date")
          );
          const daysField = fieldIds?.days != null ? fields.find((f) => f && f.id === fieldIds.days) : null;
          const yearField = fieldIds?.year != null ? fields.find((f) => f && f.id === fieldIds.year) : null;
          const deptField =
            fieldIds?.department != null ? fields.find((f) => f && f.id === fieldIds.department) : null;
          if (!personField || !periodField) continue;

          const empId = personField.value && personField.value.id;
          if (!empId) continue;

          const startIso = periodField.value;
          const periodDurationMin = Number(periodField.duration || 0);
          let durationMin = periodDurationMin;
          if (!durationMin && daysField && Number(daysField.value) > 0) {
            durationMin = Number(daysField.value) * 24 * 60;
          }
          if (!startIso) continue;
          const daysCount = daysField && Number(daysField.value) > 0 ? Number(daysField.value) : 0;

          // due_date приходит как "YYYY-MM-DD" (локальная дата, без сдвига),
          // due_date_time — как ISO в UTC (сдвигаем в бизнес-часовой пояс).
          // Период в днях (так его создаёт Pyrus и сайт): "YYYY-MM-DDT00:00:00Z" — дата без времени.
          // Длину берём из «Кол-во дней»; без него — из duration
          // (у due_date_time это «последний день − первый», у due_date — длина целиком).
          let startShiftedMs;
          let endShiftedMs;
          const dateOnly = String(startIso).match(/^(\d{4})-(\d{2})-(\d{2})(T00:00:00(?:\.000)?Z)?$/);
          if (dateOnly && (daysCount > 0 || dateOnly[4])) {
            const [yy, mm, dd] = dateOnly.slice(1, 4).map(Number);
            startShiftedMs = Date.UTC(yy, mm - 1, dd, 0, 0, 0, 0);
            const lengthDays = daysCount > 0 ? daysCount : Math.floor(periodDurationMin / 1440) + 1;
            endShiftedMs = startShiftedMs + lengthDays * DAY_MS;
          } else if (dateOnly) {
            if (!durationMin) continue;
            const [yy, mm, dd] = dateOnly.slice(1, 4).map(Number);
            startShiftedMs = Date.UTC(yy, mm - 1, dd, 0, 0, 0, 0);
            endShiftedMs = startShiftedMs + durationMin * 60 * 1000;
          } else {
            if (!durationMin) continue;
            const startUtcMs = new Date(startIso).getTime();
            if (Number.isNaN(startUtcMs)) continue;
            startShiftedMs = startUtcMs + offsetMs;
            endShiftedMs = startShiftedMs + durationMin * 60 * 1000;
          }

          const segStart = Math.max(startShiftedMs, monthStartShiftedMs);
          const segEnd = Math.min(endShiftedMs, monthEndShiftedMs);
          if (segStart >= segEnd) continue;

          const startDay = new Date(segStart).getUTCDate();

          const endDate = new Date(segEnd);
          let endDayExclusive;
          if (endDate.getUTCMonth() !== monthIndex) {
            endDayExclusive = daysInMonth + 1;
          } else {
            endDayExclusive = endDate.getUTCDate();
            if (!isMidnight(segEnd)) endDayExclusive += 1;
          }

          endDayExclusive = Math.max(1, Math.min(daysInMonth + 1, endDayExclusive));

          let endLabelShiftedMs = endShiftedMs;
          if (isMidnight(endShiftedMs)) endLabelShiftedMs = endShiftedMs - 1;

          (vacationsByEmployee[empId] = vacationsByEmployee[empId] || []).push({
            taskId: task.id ?? null,
            department: String(deptField?.value?.choice_names?.[0] ?? "").trim(),
            startDay,
            endDayExclusive,
            startLabel: fmt(startShiftedMs),
            endLabel: fmt(endLabelShiftedMs),
            year: yearField ? String(yearField.value ?? "") : "",
            days: daysField && daysField.value != null ? Number(daysField.value) : null,
          });
        }

        for (const empId of Object.keys(vacationsByEmployee)) {
          vacationsByEmployee[empId].sort(
            (a, b) => (a.startDay || 0) - (b.startDay || 0)
          );
        }

        return vacationsByEmployee;
      }
    );
  }

  function peekVacationsForMonth(monthKey) {
    const entry = peekCache(`pyrus:vacations:${monthKey}`);
    return entry && entry.value ? entry.value : null;
  }

  return { getVacationsForMonth, peekVacationsForMonth, applyCreated, applyDeleted };
}
