// js/api/apiClient.js
//
// Единственная точка сетевого обмена с бэкендом.
// Контракт: POST {baseUrl}  body: { action, payload }
//           Authorization: Bearer <sessionToken> (кроме auth.start / auth.verify)
// Сейчас бэкенд — webhook n8n, потом — сервис в Docker. Фронт при переезде не меняется.
// Описание действий: docs/API_CONTRACT.md

import { createLogger } from "../utils/logger.js";

export const API_ACTIONS = Object.freeze({
  AUTH_START: "auth.start",
  AUTH_VERIFY: "auth.verify",
  AUTH_ME: "auth.me",
  AUTH_LOGOUT: "auth.logout",
  PYRUS_REQUEST: "pyrus.request",
  SCHEDULE_SAVE: "schedule.save",
});

const PUBLIC_ACTIONS = new Set([API_ACTIONS.AUTH_START, API_ACTIONS.AUTH_VERIFY]);

export function createApiClient({ baseUrl, timeoutMs = 30000, getToken, onUnauthorized, fetchFn = fetch, logger } = {}) {
  if (!baseUrl) throw new Error("apiClient: не задан api.baseUrl в config.json");
  const log = logger || createLogger("api");

  async function call(action, payload = {}) {
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
      if (err?.name === "AbortError") throw new Error("Сервер не ответил вовремя");
      throw new Error("Нет связи с сервером");
    } finally {
      clearTimeout(timer);
    }

    const contentType = res.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await res.json().catch(() => null) : null;

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

    if (!body) throw new Error("Некорректный ответ сервера (ожидался JSON)");
    // Формат ответа: { ok: true, data: ... }. Для совместимости принимаем и «голый» JSON.
    return Object.prototype.hasOwnProperty.call(body, "data") && Object.prototype.hasOwnProperty.call(body, "ok")
      ? body.data
      : body;
  }

  return { call };
}
