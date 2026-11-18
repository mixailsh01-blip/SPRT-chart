// js/api/apiClient.js
//
// Единственная точка сетевого обмена с бэкендом.
// Контракт: POST {baseUrl}  body: { action, payload }
//           Authorization: Bearer <sessionToken> (кроме auth.start / auth.verify)
// Описание действий: docs/API_CONTRACT.md

import { recordDiagnostic } from "../utils/diagnostics.js";
import { createLogger } from "../utils/logger.js";

export const API_ACTIONS = Object.freeze({
  AUTH_START: "auth.start",
  AUTH_VERIFY: "auth.verify",
  AUTH_LINK: "auth.link",
  AUTH_ME: "auth.me",
  AUTH_LOGOUT: "auth.logout",
  PYRUS_REQUEST: "pyrus.request",
  SCHEDULE_SAVE: "schedule.save",
  VACATION_CREATE: "vacation.create",
  VACATION_DELETE: "vacation.delete",
  VACATION_APPROVE: "vacation.approve",
  SCHEDULE_SWAP: "schedule.swap",
  SETTINGS_SHIFT_SAVE: "settings.shift.save",
  SETTINGS_SHIFT_DELETE: "settings.shift.delete",
  SETTINGS_ROLE_SET: "settings.role.set",
  LUNCH_STATUS: "lunch.status",
  LUNCH_START: "lunch.start",
  LUNCH_END: "lunch.end",
  LUNCH_LIST: "lunch.list",
  ATTENDANCE_LIST: "attendance.list",
  ATTENDANCE_SAVE: "attendance.save",
  ATTENDANCE_EXPORT: "attendance.export",
});

const PUBLIC_ACTIONS = new Set([API_ACTIONS.AUTH_START, API_ACTIONS.AUTH_VERIFY, API_ACTIONS.AUTH_LINK]);

export function createApiClient({ baseUrl, timeoutMs = 30000, getToken, onUnauthorized, fetchFn = fetch, logger } = {}) {
  if (!baseUrl) throw new Error("apiClient: не задан api.baseUrl в config.json");
  const log = logger || createLogger("api");

  async function request(action, payload = {}) {
    if (!action) throw new Error("apiClient.call: не указан action");
    if (!Object.values(API_ACTIONS).includes(action)) {
      log.warn(`apiClient.call: неизвестный action "${action}"`);
    }

    const headers = { "Content-Type": "application/json" };
    const token = typeof getToken === "function" ? getToken() : null;
    if (token && !PUBLIC_ACTIONS.has(action)) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetchFn(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ action, payload }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw Object.assign(new Error(err?.name === "AbortError" ? "Сервер не ответил вовремя" : "Нет связи с сервером"), {
        code: err?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
      });
    }

    try {
      const contentType = res.headers.get("content-type") || "";
      const body = contentType.includes("application/json") ? await res.json().catch(error => {
        if (controller.signal.aborted) throw Object.assign(new Error("Сервер не ответил вовремя"), { code: "TIMEOUT" });
        if (error instanceof SyntaxError) return null;
        throw Object.assign(new Error("Соединение прервано при загрузке ответа"), { code: "NETWORK_ERROR" });
      }) : null;

      if (res.status === 401 && !PUBLIC_ACTIONS.has(action)) {
        if (typeof onUnauthorized === "function") onUnauthorized();
      }

      if (!res.ok || (body && body.ok === false)) {
        const errorPayload = body?.error ?? {};
        const message =
          (typeof errorPayload === "string" && errorPayload) ||
          errorPayload.message ||
          body?.message ||
          `Ошибка HTTP ${res.status}`;
        const error = new Error(message);
        error.status = res.status;
        error.code = errorPayload.code || body?.code || null;
        error.retryAfterSec = Number(errorPayload.retryAfterSec || res.headers.get("retry-after")) || 0;
        throw error;
      }

      if (action === API_ACTIONS.ATTENDANCE_EXPORT && contentType.includes("application/pdf")) {
        return await res.blob();
      }
      if (!body) throw Object.assign(new Error("Некорректный ответ сервера (ожидался JSON)"), { code: "INVALID_RESPONSE" });
      // Формат ответа: { ok: true, data: ... }. Для совместимости принимаем и «голый» JSON.
      return Object.prototype.hasOwnProperty.call(body, "data") && Object.prototype.hasOwnProperty.call(body, "ok")
        ? body.data
        : body;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(action, payload = {}) {
    const readOnly = action === "pyrus.request" && (!payload.method || payload.method === "GET") ||
      ["auth.me", "attendance.list", "lunch.status", "lunch.list"].includes(action);
    const path = action === "pyrus.request" && /^\/v4\/[a-z0-9/]+$/i.test(payload.path || "") ? payload.path : undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const start = Date.now();
      recordDiagnostic("request.start", { action, path, attempt, online: navigator.onLine });
      try {
        const result = await request(action, payload);
        recordDiagnostic("request.success", { action, path, attempt, durationMs: Date.now() - start });
        return result;
      } catch (error) {
        recordDiagnostic("request.error", {
          action, path, attempt, durationMs: Date.now() - start, status: error.status, code: error.code,
          online: navigator.onLine,
        });
        const transient = ["NETWORK_ERROR", "TIMEOUT"].includes(error.code) ||
          [408, 502, 503, 504].includes(error.status);
        if (!readOnly || !transient || attempt === 2 || !navigator.onLine) throw error;
        recordDiagnostic("request.retry", { action, path, attempt });
        await new Promise(resolve => setTimeout(resolve, 700));
      }
    }
  }

  return { call };
}
