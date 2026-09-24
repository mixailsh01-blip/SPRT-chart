import { cached, invalidateByPrefix, invalidateKey } from "../cache/requestCache.js";
import { unwrapPyrusData } from "../api/pyrusClient.js";

const SCHEDULE_TTL_MS = 90_000;

export function createScheduleService({ pyrusClient, formId } = {}) {
  if (!pyrusClient || typeof pyrusClient.pyrusRequest !== "function") {
    throw new Error("pyrusClient is required for scheduleService");
  }

  let latestToken = 0;

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
      data,
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

  return { loadMonthSchedule, invalidateMonthSchedule, invalidateAllSchedule };
}
