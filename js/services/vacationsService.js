import { cached, peekCache } from "../cache/requestCache.js";
import { unwrapPyrusData } from "../api/pyrusClient.js";

const DEFAULT_VACATIONS_TTL_MS = 3 * 60 * 60 * 1000; // 3h

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
        const tasks = (wrapper && wrapper.tasks) || [];

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
          if (!personField || !periodField) continue;

          const empId = personField.value && personField.value.id;
          if (!empId) continue;

          const startIso = periodField.value;
          let durationMin = Number(periodField.duration || 0);
          if (!durationMin && daysField && Number(daysField.value) > 0) {
            durationMin = Number(daysField.value) * 24 * 60;
          }
          if (!startIso || !durationMin) continue;

          // due_date приходит как "YYYY-MM-DD" (локальная дата, без сдвига),
          // due_date_time — как ISO в UTC (сдвигаем в бизнес-часовой пояс).
          let startShiftedMs;
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(startIso))) {
            const [yy, mm, dd] = String(startIso).split("-").map(Number);
            startShiftedMs = Date.UTC(yy, mm - 1, dd, 0, 0, 0, 0);
          } else {
            const startUtcMs = new Date(startIso).getTime();
            if (Number.isNaN(startUtcMs)) continue;
            startShiftedMs = startUtcMs + offsetMs;
          }
          const endShiftedMs = startShiftedMs + durationMin * 60 * 1000;

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

  return { getVacationsForMonth, peekVacationsForMonth };
}
