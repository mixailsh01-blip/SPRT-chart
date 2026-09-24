import { cached, invalidateByPrefix, invalidateKey } from "../cache/requestCache.js";
import { unwrapPyrusData } from "../api/pyrusClient.js";

const SCHEDULE_TTL_MS = 90_000;
// Реестр Pyrus обновляется с задержкой: только что созданные/изменённые задачи
// какое-то время в нём не видны. Держим результат сохранения поверх реестра.
const RECENT_WRITES_TTL_MS = 5 * 60_000;

export function createScheduleService({ pyrusClient, formId } = {}) {
  if (!pyrusClient || typeof pyrusClient.pyrusRequest !== "function") {
    throw new Error("pyrusClient is required for scheduleService");
  }

  let latestToken = 0;
  const recentUpserts = new Map(); // task_id -> { task, at }
  const recentDeletes = new Map(); // task_id -> at

  function pruneRecent() {
    const border = Date.now() - RECENT_WRITES_TTL_MS;
    for (const [id, v] of recentUpserts) if (v.at < border) recentUpserts.delete(id);
    for (const [id, at] of recentDeletes) if (at < border) recentDeletes.delete(id);
  }

  function withRecentWrites(data) {
    pruneRecent();
    if (!recentUpserts.size && !recentDeletes.size) return data;
    const isArray = Array.isArray(data);
    const wrapper = isArray ? data[0] : data;
    if (!wrapper || typeof wrapper !== "object") return data;

    const byId = new Map();
    for (const t of wrapper.tasks || []) byId.set(t.id, t);
    for (const [id, { task }] of recentUpserts) {
      const current = byId.get(id);
      // Реестр уже догнал — берём его версию, если она не старее сохранённой
      if (current && String(current.last_modified_date || "") >= String(task.last_modified_date || "")) continue;
      byId.set(id, task);
    }
    for (const id of recentDeletes.keys()) byId.delete(id);

    const merged = { ...wrapper, tasks: [...byId.values()] };
    return isArray ? [merged, ...data.slice(1)] : merged;
  }

  function applySaveResult(result) {
    if (!result || typeof result !== "object") return;
    const at = Date.now();
    for (const task of result.tasks || []) {
      if (task && task.id != null) {
        recentUpserts.set(task.id, { task, at });
        recentDeletes.delete(task.id);
      }
    }
    for (const id of result.deletedIds || []) {
      recentDeletes.set(id, at);
      recentUpserts.delete(id);
    }
  }

  async function loadMonthSchedule(monthKey, { force } = {}) {
    const token = ++latestToken;
    const data = await cached(
      `pyrus:schedule:${monthKey}`,
      { ttlMs: SCHEDULE_TTL_MS, force },
      async () => {
        const raw = await pyrusClient.pyrusRequest(`/v4/forms/${formId}/register`, {
          method: "GET",
        });
        return unwrapPyrusData(raw);
      }
    );

    return {
      data: withRecentWrites(data),
      monthKey,
      isLatest: token === latestToken,
    };
  }

  function invalidateMonthSchedule(monthKey) {
    if (!monthKey) return;
    invalidateKey(`pyrus:schedule:${monthKey}`);
  }

  function invalidateAllSchedule() {
    invalidateByPrefix("pyrus:schedule:");
  }

  return { loadMonthSchedule, invalidateMonthSchedule, invalidateAllSchedule, applySaveResult };
}
