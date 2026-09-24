// app.js
// Главный модуль SPA «График смен» (SPRT-chart)
// Чистый vanilla JS.

import { config, getConfigValue } from "./config.js?v=6";
import { createApiClient } from "./api/apiClient.js";
import { createPyrusClient, unwrapPyrusData } from "./api/pyrusClient.js";
import { createMembersService } from "./services/membersService.js";
import { createCatalogsService } from "./services/catalogsService.js";
import { createVacationsService } from "./services/vacationsService.js";
import { createScheduleService } from "./services/scheduleService.js?v=6";
import { createProdCalendarService } from "./services/prodCalendarService.js?v=2";


/**
 * Основные сущности:
 * - Авторизация на бэкенде: auth.start / auth.verify (провайдер из config.auth.provider)
 * - Pyrus API через бэкенд: action "pyrus.request" (белый список путей на бэкенде)
 * - Кеширование данных смен в памяти
 * - UI: таблица, ховер строки, анимация ячеек, компактный поповер смены
 * - Права: edit/view по подразделениям (config.lines[].editRoles)
 */
// Единый источник истины — нормализованный config.
// window.APP_CONFIG оставляем только как отладочный дамп в config.js, без чтения здесь.

const API_BASE_URL = getConfigValue("api.baseUrl", { required: true });

const MAX_DAYS_IN_MONTH = 31;

// Нерабочие праздничные дни РФ (ст. 112 ТК) — на случай, если производственный
// календарь ещё не опубликован. Переносы выходных сюда не входят.
const FIXED_RU_HOLIDAYS = {
  1: [1, 2, 3, 4, 5, 6, 7, 8],
  2: [23],
  3: [8],
  5: [1, 9],
  6: [12],
  11: [4],
};

// Бизнес-часовой пояс (по умолчанию GMT+4)
const TIMEZONE_OFFSET_MIN = getConfigValue("timezone.localOffsetMin", {
  defaultValue: 4 * 60,
  required: true,
}); // GMT+4



// -----------------------------
// Конфиг вкладок (подразделений)
// -----------------------------
// Вкладки строятся из config.lines. "ALL" (ВСЕ) — служебная вкладка со всем графиком.
const LINES = config.lines.map((l) => ({
  ...l,
  memberRoles: Array.isArray(l.memberRoles) ? l.memberRoles.map(Number) : [],
  orgDepartmentIds: Array.isArray(l.orgDepartmentIds) ? l.orgDepartmentIds.map(Number) : [],
  editRoles: Array.isArray(l.editRoles) ? l.editRoles.map(String) : [],
}));
const LINE_KEYS = LINES.map((l) => l.key);
const ALL_LINE_KEYS = ["ALL", ...LINE_KEYS];
const LINE_KEYS_IN_UI_ORDER = ALL_LINE_KEYS;
const LINE_LABELS = Object.fromEntries([["ALL", "ВСЕ"], ...LINES.map((l) => [l.key, l.label])]);
const LINE_BY_KEY = Object.fromEntries(LINES.map((l) => [l.key, l]));
window.APP_LINE_LABELS = LINE_LABELS; // для js/shift-colors.js (легенда)

// Руководители (всегда сверху во "ВСЕ")
const TOP_MANAGEMENT_IDS = (config.management?.topManagementIds || []).map(Number);

const PYRUS_CATALOG_IDS = config.pyrus.catalogs;
const PYRUS_CATALOG_COLUMNS = config.pyrus.catalogColumns || {};
const PYRUS_FORM_IDS = config.pyrus.forms;
const PYRUS_FIELD_IDS = config.pyrus.fields;

function makeByLine(factory) {
  return Object.fromEntries(ALL_LINE_KEYS.map((k) => [k, factory(k)]));
}

// item_id элемента справочника подразделений для вкладки (нужен при сохранении смены)
function getDepartmentItemIdForLine(lineKey) {
  const line = LINE_BY_KEY[lineKey];
  return line && line.departmentItemId != null ? Number(line.departmentItemId) : null;
}

// Вкладка по значению поля «Подразделение» в задаче смены
function resolveLineKeyByDepartmentValue(value) {
  if (!value || typeof value !== "object") return null;
  const itemId = value.item_id ?? value.id ?? null;
  if (itemId != null) {
    const byId = LINES.find((l) => l.departmentItemId != null && Number(l.departmentItemId) === Number(itemId));
    if (byId) return byId.key;
  }
  const names = [];
  if (Array.isArray(value.values)) names.push(...value.values);
  if (Array.isArray(value.rows)) names.push(...value.rows.flat());
  if (value.name) names.push(value.name);
  const normalized = names.map((n) => String(n || "").trim().toUpperCase()).filter(Boolean);
  const byName = LINES.find((l) => normalized.includes(l.departmentName.trim().toUpperCase()));
  return byName ? byName.key : null;
}

function resolveLineKeyByToken(token) {
  const u = String(token || "").trim().toUpperCase();
  if (!u) return null;
  if (u === "ВСЕ" || u === "ALL") return "ALL";
  const line = LINES.find(
    (l) => l.key.toUpperCase() === u || l.label.toUpperCase() === u || l.departmentName.toUpperCase() === u
  );
  return line ? line.key : null;
}

const LINE_PERMISSION_KEYS = ALL_LINE_KEYS;

const apiClient = createApiClient({
  baseUrl: API_BASE_URL,
  timeoutMs: config.api?.timeoutMs,
  getToken: () => state.auth.sessionToken || null,
  onUnauthorized: () => handleSessionExpired(),
});
const pyrusClient = createPyrusClient({ apiClient });
const membersService = createMembersService({ pyrusClient });
const catalogsService = createCatalogsService({ pyrusClient });
const vacationsService = createVacationsService({
  pyrusClient,
  formId: PYRUS_FORM_IDS.vacations,
  fieldIds: PYRUS_FIELD_IDS.vacations,
  timezoneOffsetMin: TIMEZONE_OFFSET_MIN,
});
const scheduleService = createScheduleService({
  pyrusClient,
  formId: PYRUS_FORM_IDS.schedule,
});
const prodCalendarService = createProdCalendarService({ config });

const EDIT_ALL_ROLES = (config.auth?.permissions?.editAll || []).map(String);

function buildDefaultPermissions() {
  const permissions = {};
  for (const key of LINE_PERMISSION_KEYS) {
    permissions[key] = "view";
  }
  return permissions;
}

function normalizePermissions(rawPermissions) {
  const permissions = buildDefaultPermissions();
  if (!rawPermissions || typeof rawPermissions !== "object") return permissions;
  for (const key of LINE_PERMISSION_KEYS) {
    permissions[key] = rawPermissions[key] === "edit" ? "edit" : "view";
  }
  return permissions;
}

// Права для UI по ролям Pyrus. Бэкенд обязан проверять те же права при schedule.save.
function resolvePermissionsFromRoles(roles) {
  const permissions = buildDefaultPermissions();
  const normalizedRoles = Array.isArray(roles)
    ? roles.map((role) => String(role?.id ?? role).trim()).filter(Boolean)
    : [];
  if (normalizedRoles.length === 0) return permissions;

  const hasAny = (list) => list.some((role) => normalizedRoles.includes(String(role)));
  const editAll = hasAny(EDIT_ALL_ROLES);

  for (const line of LINES) {
    if (editAll || hasAny(line.editRoles)) permissions[line.key] = "edit";
  }
  // "ВСЕ" — сводная вкладка только для просмотра: у каждой смены должно быть подразделение
  permissions.ALL = "view";
  return permissions;
}


// -----------------------------
// Глобальное состояние
// -----------------------------

const state = {
  auth: {
    user: null,
    roles: null,
    memberId: null,
    sessionToken: null,
    permissions: buildDefaultPermissions(),
  },
  ui: {
    currentLine: "ALL",
    theme: "dark",
    isScheduleCached: false,
    quickPanelBound: false,
  },
  quickMode: {
    enabled: false,
    templateId: null,
    timeFrom: "",
    timeTo: "",
    amount: "",
  },
  employeesByLine: makeByLine(() => []),
  shiftTemplatesByLine: makeByLine(() => []),
  scheduleByLine: makeByLine(() => ({ monthKey: null, days: [], rows: [] })),
  originalScheduleByLine: makeByLine(() => ({ monthKey: null, days: [], rows: [] })),
  localChanges: {},
  changeHistory: [],
  monthMeta: {
    year: null,
    monthIndex: null,
  },
  vacationsByEmployee: {},
  employeeFiltersByLine: makeByLine(() => []),
};

const DEFAULT_AUTH_PERMISSIONS = buildDefaultPermissions();

const AUTH_PERMISSION_KEYS = Object.keys(DEFAULT_AUTH_PERMISSIONS);


const STORAGE_KEYS = config.storage.keys;

const CALENDAR_THEME_VAR_MAP = {
  tableHeaderDayoffBg: "--table-header-dayoff-bg",
  tableHeaderPreholidayBg: "--table-header-preholiday-bg",
  calendarHolidayBg: "--calendar-holiday-bg",
  calendarHolidayBorder: "--calendar-holiday-border",
  calendarWeekendBg: "--calendar-weekend-bg",
  calendarPreholidayBg: "--calendar-preholiday-bg",
  calendarPreholidayDash: "--calendar-preholiday-dash",
  weekendBg: "--weekend-bg",
  weekendStrong: "--weekend-strong",
};

const CALENDAR_INDICATOR_VAR_MAP = {
  birthdayBg: "--indicator-birthday-bg",
  birthdayText: "--indicator-birthday-text",
};

function applyThemeConfigVariables() {
  const indicators = config.calendar?.indicators ?? {};
  const rootStyle = document.documentElement.style;

  for (const [key, cssVar] of Object.entries(CALENDAR_INDICATOR_VAR_MAP)) {
    const value = indicators[key];
    if (typeof value === "string") {
      rootStyle.setProperty(cssVar, value);
    }
  }
}


function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function updateCurrentUserLabel(login) {
  if (!currentUserLabelEl) return;
  const name = state.auth.user?.name || "";
  currentUserLabelEl.textContent = name || (login || state.auth.user?.login || "").trim();
}

function normalizeAuthUser(rawUser, overrides = {}) {
  if (!rawUser && !overrides.login && !overrides.name && overrides.id == null && !overrides.roles) {
    return null;
  }
  const source = rawUser || {};
  const id = source.id ?? overrides.id ?? null;
  const login = String(source.login ?? overrides.login ?? "").trim();
  let name = String(source.name ?? overrides.name ?? "").trim();
  if (!name) {
    const firstName = source.first_name ?? source.firstName ?? overrides.first_name ?? overrides.firstName ?? "";
    const lastName = source.last_name ?? source.lastName ?? overrides.last_name ?? overrides.lastName ?? "";
    name = `${lastName} ${firstName}`.trim();
  }
  let rolesRaw = source.roles ?? overrides.roles ?? [];
  if (!Array.isArray(rolesRaw)) rolesRaw = [];
  const roles = rolesRaw.map((role) => String(role)).filter(Boolean);
  return {
    id,
    login,
    name,
    roles,
  };
}

function normalizeAuthPermissions(permissions) {
  const normalized = { ...DEFAULT_AUTH_PERMISSIONS };
  if (permissions && typeof permissions === "object") {
    for (const [key, value] of Object.entries(permissions)) {
      if (value) normalized[key] = value;
    }
  }
  const fallback = normalized.ALL || DEFAULT_AUTH_PERMISSIONS.ALL;
  for (const key of AUTH_PERMISSION_KEYS) {
    if (!permissions || !Object.prototype.hasOwnProperty.call(permissions, key)) {
      normalized[key] = fallback;
    }
  }
  return normalized;
}

function applyAuthState({ user, permissions, login, name, id, roles } = {}) {
  state.auth.user = normalizeAuthUser(user, {
    login,
    name,
    id,
    roles,
  });
  state.auth.permissions = normalizeAuthPermissions(permissions);
  return state.auth.user;
}

// -----------------------------
// Проверка прав доступа
// -----------------------------

function canEditLine(line) {
  const permission = state.auth.permissions[line] || state.auth.permissions.ALL;
  return permission === "edit";
}

function canViewLine(line) {
  const permission = state.auth.permissions[line] || state.auth.permissions.ALL;
  return permission === "view" || permission === "edit";
}


// -----------------------------
// Персистентная авторизация (localStorage + cookie)
// -----------------------------

const AUTH_STORAGE_KEY = config.storage.auth.key;
const AUTH_TTL_MS =
  Number(config.storage.auth.sessionTtlMs ?? config.storage.auth.ttlMs) || 0; // 7 дней
const AUTH_COOKIE_DAYS = config.storage.auth.cookieDays;

const AUTH_METHOD = `code:${config.auth?.provider || "mango"}`;


function setCookie(name, value, days) {
  try {
    const expires = new Date(Date.now() + days * 86400000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  } catch (_) {}
}

function getCookie(name) {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()\[\]\\\/\+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  } catch (_) {
    return null;
  }
}

function clearCookie(name) {
  try {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
  } catch (_) {}
}

function clearAllCookies() {
  try {
    const cookies = document.cookie.split(";").map((cookie) => cookie.trim()).filter(Boolean);
    cookies.forEach((cookie) => {
      const name = cookie.split("=")[0];
      if (name) clearCookie(name);
    });
  } catch (_) {}
}

function clearAllAppStorage() {
  try {
    localStorage.clear();
  } catch (_) {}
  try {
    sessionStorage.clear();
  } catch (_) {}
}

function clearAllCacheAndCookies() {
  clearAllAppStorage();
  clearAllCookies();
}

function saveAuthCache(login) {
  // пароль не сохраняем
  const payload = {
    savedAt: Date.now(),
    authMethod: AUTH_METHOD,
    sessionToken: state.auth.sessionToken || null,
    login: login || "",
    user: state.auth.user || null,
    roles: state.auth.roles || null,
    memberId: state.auth.memberId || null,

    permissions: state.auth.permissions || null,
  };
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
  // Дублируем в cookie (минимальный объём) — на случай очистки localStorage
  setCookie(AUTH_STORAGE_KEY, JSON.stringify(payload), AUTH_COOKIE_DAYS);
}

function loadAuthCache() {
  let raw = null;
  try {
    raw = localStorage.getItem(AUTH_STORAGE_KEY);
  } catch (_) {}
  if (!raw) raw = getCookie(AUTH_STORAGE_KEY);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    if (!data || !data.savedAt) return null;
    if (Date.now() - data.savedAt > AUTH_TTL_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function readRawAuthCache() {
  let raw = null;
  try {
    raw = localStorage.getItem(AUTH_STORAGE_KEY);
  } catch (_) {}
  if (!raw) raw = getCookie(AUTH_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function clearAuthCache() {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch (_) {}
  clearCookie(AUTH_STORAGE_KEY);
}

function getTodayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function applyAuthCache(data) {
  if (!data || !data.sessionToken) return false;
  state.auth.sessionToken = data.sessionToken;
  state.auth.user = data.user || null;
  state.auth.roles = data.roles || null;
  state.auth.memberId = data.memberId || null;
  state.auth.login = data.login || null;
  state.auth.permissions = state.auth.roles
    ? resolvePermissionsFromRoles(state.auth.roles)
    : normalizePermissions(data.permissions);

  const login = (data.login || state.auth.user?.login || "").trim();
  updateCurrentUserLabel(state.auth.user?.name || login);
  return true;
}

function resetAuthState() {
  clearAuthCache();
  state.auth.user = null;
  state.auth.roles = null;
  state.auth.memberId = null;
  state.auth.sessionToken = null;
  state.auth.permissions = buildDefaultPermissions();
}

let sessionExpiredHandled = false;
function handleSessionExpired() {
  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  resetAuthState();
  showLoginScreen();
  resetEmailAuthState(true);
  if (emailRequestErrorEl) emailRequestErrorEl.textContent = "Сессия истекла — войдите снова";
  setTimeout(() => {
    sessionExpiredHandled = false;
  }, 1000);
}

function getCurrentLinePermission() {
  return state.auth.permissions[state.ui.currentLine];
}

// -----------------------------
// Утилиты времени
// -----------------------------

// Нормализация времени к формату HH:MM.
// Принимает также "2:00", "2", "02", "14.30" и т.п.
function normalizeTimeHHMM(raw) {
  if (raw == null) return "";
  const s = String(raw).trim().replace(".", ":");
  if (!s) return "";

  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return s;

  const hh = String(parseInt(m[1], 10)).padStart(2, "0");
  const mm = String(parseInt(m[2] || "0", 10)).padStart(2, "0");
  return `${hh}:${mm}`;
}

function parseShiftTimeRangeString(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/\s+/g, "");
  const [startRaw, endRaw] = cleaned.split("-");
  if (!startRaw || !endRaw) return null;

  const norm = (part) => {
    const withColon = part.replace(".", ":");
    const [hStr, mStr = "00"] = withColon.split(":");
    const h = String(parseInt(hStr, 10)).padStart(2, "0");
    const m = String(parseInt(mStr, 10)).padStart(2, "0");
    return `${h}:${m}`;
  };

  return { start: norm(startRaw), end: norm(endRaw) };
}

function addMinutesLocal(baseMinutes, delta) {
  let total = baseMinutes + delta;
  let dayShift = 0;
  while (total < 0) {
    total += 24 * 60;
    dayShift -= 1;
  }
  while (total >= 24 * 60) {
    total -= 24 * 60;
    dayShift += 1;
  }
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return { time: `${hh}:${mm}`, dayShift };
}

function convertUtcStartToLocalRange(utcIsoString, durationMinutes) {
  if (!utcIsoString || typeof utcIsoString !== "string") return null;
  const startUtc = new Date(utcIsoString);
  if (Number.isNaN(startUtc.getTime())) return null;

  const startLocalMs = startUtc.getTime() + TIMEZONE_OFFSET_MIN * 60 * 1000;
  const startLocalDate = new Date(startLocalMs);

  const startHH = String(startLocalDate.getUTCHours()).padStart(2, "0");
  const startMM = String(startLocalDate.getUTCMinutes()).padStart(2, "0");
  const startLocal = `${startHH}:${startMM}`;

  const startMinutes =
    startLocalDate.getUTCHours() * 60 + startLocalDate.getUTCMinutes();
  const { time: endLocal } = addMinutesLocal(
    startMinutes,
    durationMinutes || 0
  );

  const y = startLocalDate.getUTCFullYear();
  const m = String(startLocalDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(startLocalDate.getUTCDate()).padStart(2, "0");

  return {
    localDateKey: `${y}-${m}-${d}`,
    startLocal,
    endLocal,
  };
}

function formatShiftTimeForCell(startLocal, endLocal) {
  return { start: startLocal, end: endLocal };
}

function parseTimeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const [hh, mm] = hhmm.split(":").map((p) => Number(p));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

function computeDurationMinutes(startLocal, endLocal) {
  const start = parseTimeToMinutes(startLocal);
  const end = parseTimeToMinutes(endLocal);
  if (start == null || end == null) return null;
  let diff = end - start;
  if (diff <= 0) diff += 24 * 60;
  return diff;
}

function convertLocalRangeToUtcWithMeta(year, monthIndex, day, startLocal, endLocal) {
  try {
    const durationMinutes = computeDurationMinutes(startLocal, endLocal);
    if (durationMinutes == null) return null;

    const y = Number(year);
    const m = Number(monthIndex);
    const d = Number(day);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;

    // Стартовое локальное время (HH:MM)
    const startMin = parseTimeToMinutes(startLocal);
    if (startMin == null) return null;
    const hhNum = Math.floor(startMin / 60);
    const mmNum = startMin % 60;
    const offsetMs = TIMEZONE_OFFSET_MIN * 60 * 1000;
    const baseUtcMs = Date.UTC(y, m, d, hhNum, mmNum);
    if (!Number.isFinite(baseUtcMs)) return null;

    const startUtcMs = baseUtcMs - offsetMs;
    const endUtcMs = startUtcMs + durationMinutes * 60 * 1000;

    const startDate = new Date(startUtcMs);
    const endDate = new Date(endUtcMs);
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
      return null;
    }

    return {
      durationMinutes,
      startUtcIso: startDate.toISOString(),
      endUtcIso: endDate.toISOString(),
    };
  } catch (e) {
    console.warn("convertLocalRangeToUtcWithMeta: invalid time value", {
      year,
      monthIndex,
      day,
      startLocal,
      endLocal,
      error: String(e && e.message ? e.message : e),
    });
    return null;
  }
}

// Backwards-compatible wrapper.
function convertLocalRangeToUtc(day, startLocal, endLocal) {
  let { year, monthIndex } = state.monthMeta || {};
  if (!Number.isFinite(Number(year)) || !Number.isFinite(Number(monthIndex))) {
    const now = new Date();
    year = now.getFullYear();
    monthIndex = now.getMonth();
  }
  return convertLocalRangeToUtcWithMeta(year, monthIndex, day, startLocal, endLocal);
}

// -----------------------------
// DOM-ссылки
// -----------------------------

const $ = (sel) => document.querySelector(sel);

const loginScreenEl = $("#login-screen");
const mainScreenEl = $("#main-screen");
const topBarEl = document.querySelector(".top-bar");

const emailInputEl = $("#email-input");
const emailSendButtonEl = $("#email-send-button");
const emailStepRequestEl = $("#email-step-request");
const emailStepCodeEl = $("#email-step-code");
const emailTargetLabelEl = $("#email-target-label");
const emailChangeButtonEl = $("#email-change-button");
const otpGroupEl = $("#otp-group");
const otpInputs = otpGroupEl ? Array.from(otpGroupEl.querySelectorAll(".otp-input")) : [];
const emailVerifyButtonEl = $("#email-verify-button");
const emailResendButtonEl = $("#email-resend-button");
const emailRequestErrorEl = $("#email-request-error");
const emailCodeErrorEl = $("#email-code-error");
const currentUserLabelEl = $("#current-user-label");
const currentMonthLabelEl = $("#current-month-label");

const lineTabsEl = $("#line-tabs");
const btnPrevMonthEl = $("#btn-prev-month");
const btnNextMonthEl = $("#btn-next-month");
const btnThemeToggleEl = $("#btn-theme-toggle");
const btnLogoutEl = $("#btn-logout");
const btnSavePyrusEl = $("#btn-save-pyrus");
const btnMobileToolbarEl = $("#btn-mobile-toolbar");
const btnMobileToolbarCloseEl = $("#btn-mobile-toolbar-close");
const btnLineTabsEl = $("#btn-line-tabs");
const btnLegendToggleEl = $("#btn-legend-toggle");
const shiftLegendEl = $("#shift-legend");
const shiftLegendBackdropEl = $("#shift-legend-backdrop");

const scheduleRootEl = $("#schedule-root");
const quickTemplateSelectEl = $("#quick-template-select");
const quickTimeFromInputEl = $("#quick-time-from");
const quickTimeToInputEl = $("#quick-time-to");
const quickAmountInputEl = $("#quick-amount");
const quickModeToggleEl = $("#quick-mode-toggle");
const changeLogListEl = $("#change-log-list");
const btnClearHistoryEl = $("#btn-clear-history");
let appToastTimer = null;

function showAppToast(message) {
  const text = String(message || "").trim() || "Сохранено.";
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "app-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("show");
  if (appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2400);
}

function syncLoginBodyState() {
  if (!loginScreenEl) return;
  document.body.classList.toggle(
    "login-active",
    !loginScreenEl.classList.contains("hidden")
  );
}

function showLoginScreen() {
  mainScreenEl?.classList.add("hidden");
  loginScreenEl?.classList.remove("hidden");
  syncLoginBodyState();
}

function showMainScreen() {
  loginScreenEl?.classList.add("hidden");
  mainScreenEl?.classList.remove("hidden");
  syncLoginBodyState();
}

// поповер смены
let shiftPopoverEl = null;
let shiftPopoverBackdropEl = null;
let shiftPopoverKeydownHandler = null;
let employeeFilterPopoverEl = null;
let employeeFilterPopoverBackdropEl = null;
let employeeFilterPopoverKeydownHandler = null;
let employeeFilterPopoverTitleEl = null;
let employeeFilterPopoverMetaEl = null;
let employeeFilterPopoverListEl = null;
let employeeFilterPopoverControlsEl = null;
let legendKeydownHandler = null;
let lineTabsPopoverBackdropEl = null;
let lineTabsPopoverEl = null;
let lineTabsPopoverListEl = null;
let lineTabsPopoverKeydownHandler = null;
let monthPickerBackdropEl = null;
let monthPickerEl = null;
let monthPickerYearLabelEl = null;
let monthPickerGridEl = null;
let monthPickerKeydownHandler = null;

function updateScheduleStickyOffsets() {
  if (!topBarEl) return;
  if (window.innerWidth <= 768) {
    const topBarHeight = topBarEl.offsetHeight || 0;
    const rootStyles = getComputedStyle(document.documentElement);
    const headerRowHeight =
      Number.parseFloat(rootStyles.getPropertyValue("--table-header-row-height")) || 0;
    document.documentElement.style.setProperty(
      "--schedule-sticky-top",
      `${topBarHeight}px`
    );
    document.documentElement.style.setProperty(
      "--schedule-sticky-secondary-top",
      `${topBarHeight + headerRowHeight}px`
    );
  } else {
    document.documentElement.style.removeProperty("--schedule-sticky-top");
    document.documentElement.style.removeProperty("--schedule-sticky-secondary-top");
  }
}

// -----------------------------
// Инициализация
// -----------------------------

async function init() {
  resetLocalEditingState();
  initTheme();
  loadCurrentLinePreference();
  loadEmployeeFilters();
  initMonthMetaToToday();
  bindEmailAuth();

  // Автовосстановление сессии: токен проверяет бэкенд (auth.me)
  const rawAuth = readRawAuthCache();
  if (rawAuth && rawAuth.authMethod !== AUTH_METHOD) {
    clearAllCacheAndCookies();
    resetAuthState();
    showLoginScreen();
  } else {
    const cachedAuth = loadAuthCache();
    if (cachedAuth && applyAuthCache(cachedAuth)) {
      showMainScreen();
      // Проверка сессии идёт фоном: интерфейс показываем сразу из кеша,
      // а не ждём ответа бэкенда (раньше это держало пустой экран).
      apiClient
        .call("auth.me", {})
        .then((me) => {
          if (me && (me.user || me.roles)) {
            applyAuthResult({ ...me, sessionToken: state.auth.sessionToken });
            updateSaveButtonState();
          }
        })
        .catch((err) => {
          if (err?.status === 401) {
            handleSessionExpired();
          } else {
            console.warn("auth.me недоступен, продолжаем с кешированной сессией", err);
          }
        });
    } else {
      showLoginScreen();
    }
  }

  syncLoginBodyState();
  bindTopBarButtons();
  bindHistoryControls();
  createShiftPopover();
  createEmployeeFilterPopover();
  createMonthPickerPopover();
  renderChangeLog();

  // Если восстановили сессию — загружаем данные как после логина
  if (state.auth.sessionToken && mainScreenEl && !mainScreenEl.classList.contains("hidden")) {
    loadInitialData().catch((err) => {
      console.error("Auto-login loadInitialData error:", err);
      clearAuthCache();
      showLoginScreen();
      if (emailRequestErrorEl) {
        emailRequestErrorEl.textContent = "Сессия истекла — войдите снова";
      }
    });
  }
}

function getCurrentLineTemplates() {
  return state.shiftTemplatesByLine[state.ui.currentLine] || [];
}

function initMonthMetaToToday() {
  const now = new Date();
  state.monthMeta.year = now.getFullYear();
  state.monthMeta.monthIndex = now.getMonth();
  updateMonthLabel();
}

function updateMonthLabel() {
  const { year, monthIndex } = state.monthMeta;
  const monthNames = [
    "Январь",
    "Февраль",
    "Март",
    "Апрель",
    "Май",
    "Июнь",
    "Июль",
    "Август",
    "Сентябрь",
    "Октябрь",
    "Ноябрь",
    "Декабрь",
  ];
  currentMonthLabelEl.textContent = `${monthNames[monthIndex]} ${year}`;
}

function createMonthPickerPopover() {
  if (monthPickerBackdropEl) return;
  monthPickerBackdropEl = document.createElement("div");
  monthPickerBackdropEl.className = "month-picker-backdrop hidden";

  monthPickerEl = document.createElement("div");
  monthPickerEl.className = "month-picker hidden";

  const header = document.createElement("div");
  header.className = "month-picker-header";

  const prevYearBtn = document.createElement("button");
  prevYearBtn.type = "button";
  prevYearBtn.className = "btn toggle";
  prevYearBtn.textContent = "‹";
  prevYearBtn.setAttribute("aria-label", "Предыдущий год");

  monthPickerYearLabelEl = document.createElement("div");
  monthPickerYearLabelEl.className = "month-picker-year";

  const nextYearBtn = document.createElement("button");
  nextYearBtn.type = "button";
  nextYearBtn.className = "btn toggle";
  nextYearBtn.textContent = "›";
  nextYearBtn.setAttribute("aria-label", "Следующий год");

  header.appendChild(prevYearBtn);
  header.appendChild(monthPickerYearLabelEl);
  header.appendChild(nextYearBtn);

  monthPickerGridEl = document.createElement("div");
  monthPickerGridEl.className = "month-picker-grid";

  monthPickerEl.appendChild(header);
  monthPickerEl.appendChild(monthPickerGridEl);
  monthPickerBackdropEl.appendChild(monthPickerEl);
  document.body.appendChild(monthPickerBackdropEl);

  const closeHandler = () => closeMonthPickerPopover();
  monthPickerBackdropEl.addEventListener("click", (event) => {
    if (event.target === monthPickerBackdropEl) closeHandler();
  });

  prevYearBtn.addEventListener("click", () => {
    state.monthMeta.year -= 1;
    renderMonthPicker();
  });
  nextYearBtn.addEventListener("click", () => {
    state.monthMeta.year += 1;
    renderMonthPicker();
  });
}

function renderMonthPicker() {
  if (!monthPickerGridEl || !monthPickerYearLabelEl) return;
  const { year, monthIndex } = state.monthMeta;
  monthPickerYearLabelEl.textContent = String(year);
  monthPickerGridEl.innerHTML = "";

  const monthLabels = [
    "Янв",
    "Фев",
    "Мар",
    "Апр",
    "Май",
    "Июн",
    "Июл",
    "Авг",
    "Сен",
    "Окт",
    "Ноя",
    "Дек",
  ];

  monthLabels.forEach((label, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "month-picker-month";
    btn.textContent = label;
    btn.setAttribute("aria-label", `${label} ${year}`);
    if (index === monthIndex) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.monthMeta.monthIndex = index;
      updateMonthLabel();
      closeMonthPickerPopover();
      reloadScheduleForCurrentMonth();
    });
    monthPickerGridEl.appendChild(btn);
  });
}

function openMonthPickerPopover() {
  if (!monthPickerBackdropEl || !monthPickerEl) return;
  renderMonthPicker();
  monthPickerBackdropEl.classList.remove("hidden");
  monthPickerEl.classList.remove("hidden");
  if (!monthPickerKeydownHandler) {
    monthPickerKeydownHandler = (event) => {
      if (event.key === "Escape") closeMonthPickerPopover();
    };
  }
  document.addEventListener("keydown", monthPickerKeydownHandler);
}

function closeMonthPickerPopover() {
  if (!monthPickerBackdropEl || !monthPickerEl) return;
  monthPickerBackdropEl.classList.add("hidden");
  monthPickerEl.classList.add("hidden");
  if (monthPickerKeydownHandler) {
    document.removeEventListener("keydown", monthPickerKeydownHandler);
    monthPickerKeydownHandler = null;
  }
}

function resetLocalEditingState() {
  state.localChanges = {};
  state.changeHistory = [];

  try {
    localStorage.removeItem(STORAGE_KEYS.localChanges);
    localStorage.removeItem(STORAGE_KEYS.changeHistory);
  } catch (err) {
    console.warn("Не удалось сбросить локальные данные", err);
  }
}

function persistLocalChanges() {
  try {
    localStorage.setItem(STORAGE_KEYS.localChanges, JSON.stringify(state.localChanges));
  } catch (err) {
    console.warn("Не удалось сохранить локальные смены", err);
  }
}

function persistChangeHistory() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.changeHistory,
      JSON.stringify(state.changeHistory.slice(0, 300))
    );
  } catch (err) {
    console.warn("Не удалось сохранить историю", err);
  }
}

// -----------------------------
// Авторизация: вкладки и OTP
// -----------------------------

// Состояние входа по коду. Код генерирует и проверяет только бэкенд (auth.start / auth.verify).
const emailAuthState = {
  step: "request",
  targetEmail: "", // идентификатор: телефон или email (config.auth.identifier.type)
  challengeId: null,
  resendRemaining: 0,
  timerId: null,
};

const AUTH_IDENTIFIER = config.auth?.identifier || { type: "phone" };
const AUTH_RESEND_SEC = Number(config.auth?.resendTimerSec) || 60;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeIdentifier(value) {
  const raw = String(value || "").trim();
  if (AUTH_IDENTIFIER.type === "email") return raw.toLowerCase();
  // телефон: оставляем цифры, 8XXXXXXXXXX -> 7XXXXXXXXXX
  let digits = raw.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return digits;
}

function isValidIdentifier(value) {
  if (AUTH_IDENTIFIER.type === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return /^7\d{10}$/.test(value);
}

// Применяет ответ auth.verify / auth.me: { sessionToken, user, roles, permissions }
function applyAuthResult(result) {
  const user = result?.user || {};
  state.auth.sessionToken = result?.sessionToken || state.auth.sessionToken || null;
  state.auth.memberId = user.id ?? state.auth.memberId ?? null;
  state.auth.roles = Array.isArray(result?.roles) ? result.roles : Array.isArray(user.roles) ? user.roles : null;
  state.auth.user = {
    id: user.id ?? null,
    name: String(user.name || `${user.last_name || ""} ${user.first_name || ""}`).trim(),
    login: String(user.login || user.email || user.phone || emailAuthState.targetEmail || "").trim(),
    roles: (state.auth.roles || []).map((r) => String(r?.id ?? r)),
  };
  // Приоритет: права, посчитанные бэкендом; иначе — по ролям из config.lines
  state.auth.permissions = result?.permissions
    ? normalizePermissions(result.permissions)
    : resolvePermissionsFromRoles(state.auth.roles);
  updateCurrentUserLabel(state.auth.user.name || state.auth.user.login);
  saveAuthCache(state.auth.user.login);
}

function clearAuthErrors() {
  if (emailRequestErrorEl) emailRequestErrorEl.textContent = "";
  if (emailCodeErrorEl) emailCodeErrorEl.textContent = "";
  otpGroupEl?.classList.remove("error");
}

function resetEmailAuthState(keepEmail = true) {
  clearResendTimer();
  emailAuthState.step = "request";
  emailAuthState.resendRemaining = 0;
  emailAuthState.challengeId = null;
  if (!keepEmail && emailInputEl) emailInputEl.value = "";
  if (emailTargetLabelEl) emailTargetLabelEl.textContent = "—";
  otpInputs.forEach((input) => {
    input.value = "";
  });
  updateResendButton();
  setEmailAuthStep("request");
}

function setEmailAuthStep(step) {
  emailAuthState.step = step;
  emailStepRequestEl?.classList.toggle("hidden", step !== "request");
  emailStepCodeEl?.classList.toggle("hidden", step !== "code");
  document.body.classList.toggle("auth-code-step", step === "code");
  clearAuthErrors();
  if (step === "request") {
    emailInputEl?.focus();
  } else {
    otpInputs[0]?.focus();
  }
}

function normalizeOtpValue(value) {
  return value.replace(/\D/g, "");
}

function setOtpError(message) {
  if (emailCodeErrorEl) emailCodeErrorEl.textContent = message || "";
  otpGroupEl?.classList.toggle("error", Boolean(message));
}

function getOtpValue() {
  return otpInputs.map((input) => input.value).join("");
}

function fillOtpFromString(value) {
  const digits = normalizeOtpValue(value).slice(0, otpInputs.length).split("");
  otpInputs.forEach((input, index) => {
    input.value = digits[index] || "";
  });
  const nextIndex = Math.min(digits.length, otpInputs.length - 1);
  otpInputs[nextIndex]?.focus();
}

function handleOtpInput(event) {
  const input = event.target;
  const index = otpInputs.indexOf(input);
  const clean = normalizeOtpValue(input.value);
  input.value = clean.slice(-1);
  setOtpError("");
  if (input.value && index < otpInputs.length - 1) {
    otpInputs[index + 1].focus();
  }
}

function handleOtpKeydown(event) {
  const input = event.target;
  const index = otpInputs.indexOf(input);
  if (event.key === "Backspace" && !input.value && index > 0) {
    otpInputs[index - 1].value = "";
    otpInputs[index - 1].focus();
    event.preventDefault();
  }
  if (event.key === "ArrowLeft" && index > 0) {
    otpInputs[index - 1].focus();
    event.preventDefault();
  }
  if (event.key === "ArrowRight" && index < otpInputs.length - 1) {
    otpInputs[index + 1].focus();
    event.preventDefault();
  }
}

function handleOtpPaste(event) {
  const data = event.clipboardData?.getData("text");
  if (!data) return;
  event.preventDefault();
  fillOtpFromString(data);
}

function updateResendButton() {
  if (!emailResendButtonEl) return;
  if (emailAuthState.resendRemaining > 0) {
    emailResendButtonEl.disabled = true;
    emailResendButtonEl.textContent = `Повторная отправка (${emailAuthState.resendRemaining}с)`;
  } else {
    emailResendButtonEl.disabled = false;
    emailResendButtonEl.textContent = "Повторная отправка";
  }
}

function clearResendTimer() {
  if (emailAuthState.timerId) {
    clearInterval(emailAuthState.timerId);
    emailAuthState.timerId = null;
  }
}

function startResendTimer() {
  clearResendTimer();
  emailAuthState.resendRemaining = AUTH_RESEND_SEC;
  updateResendButton();
  emailAuthState.timerId = setInterval(() => {
    emailAuthState.resendRemaining -= 1;
    if (emailAuthState.resendRemaining <= 0) {
      emailAuthState.resendRemaining = 0;
      clearResendTimer();
    }
    updateResendButton();
  }, 1000);
}

function applyAuthTexts() {
  const texts = config.auth?.texts || {};
  const labelEl = document.querySelector("#email-step-request .field span");
  if (labelEl && AUTH_IDENTIFIER.label) labelEl.textContent = AUTH_IDENTIFIER.label;
  if (emailInputEl) {
    emailInputEl.type = AUTH_IDENTIFIER.type === "email" ? "email" : "tel";
    emailInputEl.autocomplete = AUTH_IDENTIFIER.type === "email" ? "email" : "tel";
    if (AUTH_IDENTIFIER.placeholder) emailInputEl.placeholder = AUTH_IDENTIFIER.placeholder;
  }
  const hintEl = document.querySelector(".auth-panel-hint");
  if (hintEl && texts.hint) hintEl.textContent = texts.hint;
  if (emailSendButtonEl && texts.sendLabel) emailSendButtonEl.textContent = texts.sendLabel;
  if (emailVerifyButtonEl && texts.verifyLabel) emailVerifyButtonEl.textContent = texts.verifyLabel;
  if (emailChangeButtonEl && texts.changeLabel) emailChangeButtonEl.textContent = texts.changeLabel;
}

async function requestAuthCode(errorEl) {
  const identifier = emailAuthState.targetEmail;
  try {
    const result = await apiClient.call("auth.start", {
      provider: config.auth?.provider || "mango",
      identifierType: AUTH_IDENTIFIER.type,
      identifier,
    });
    emailAuthState.challengeId = result?.challengeId ?? null;
    return true;
  } catch (err) {
    if (errorEl) {
      errorEl.textContent =
        err?.code === "NOT_FOUND"
          ? "Сотрудник не найден — укажите данные, которые используете в Pyrus"
          : err?.code === "RATE_LIMITED"
          ? `Слишком часто. Повторите через ${err.retryAfterSec || AUTH_RESEND_SEC} с`
          : err?.message || "Не удалось отправить код";
    }
    return false;
  }
}

function bindEmailAuth() {
  if (!emailInputEl) return;
  applyAuthTexts();
  otpInputs.forEach((input) => {
    input.addEventListener("input", handleOtpInput);
    input.addEventListener("keydown", handleOtpKeydown);
  });
  otpGroupEl?.addEventListener("paste", handleOtpPaste);

  emailSendButtonEl?.addEventListener("click", async () => {
    clearAuthErrors();
    const identifier = normalizeIdentifier(emailInputEl.value);
    if (!isValidIdentifier(identifier)) {
      if (emailRequestErrorEl) {
        emailRequestErrorEl.textContent =
          AUTH_IDENTIFIER.type === "email" ? "Введите корректный email" : "Введите номер телефона";
      }
      emailInputEl.focus();
      return;
    }
    emailAuthState.targetEmail = identifier;
    if (emailTargetLabelEl) emailTargetLabelEl.textContent = emailInputEl.value.trim();
    otpInputs.forEach((input) => {
      input.value = "";
    });
    emailSendButtonEl.disabled = true;
    const ok = await requestAuthCode(emailRequestErrorEl);
    emailSendButtonEl.disabled = false;
    if (!ok) return;
    setEmailAuthStep("code");
    startResendTimer();
  });

  emailChangeButtonEl?.addEventListener("click", () => {
    setEmailAuthStep("request");
  });

  emailVerifyButtonEl?.addEventListener("click", async () => {
    clearAuthErrors();
    const code = getOtpValue();
    if (code.length < otpInputs.length) {
      setOtpError(`Введите ${otpInputs.length}-значный код`);
      return;
    }
    emailVerifyButtonEl.disabled = true;
    let result;
    try {
      result = await apiClient.call("auth.verify", {
        provider: config.auth?.provider || "mango",
        identifierType: AUTH_IDENTIFIER.type,
        identifier: emailAuthState.targetEmail,
        challengeId: emailAuthState.challengeId,
        code,
      });
    } catch (err) {
      const messages = {
        INVALID_CODE: "Неверный код. Попробуйте ещё раз",
        CODE_EXPIRED: "Код истёк — запросите новый",
        LOCKED: "Слишком много попыток. Попробуйте позже",
      };
      setOtpError(messages[err?.code] || err?.message || "Не удалось войти");
      return;
    } finally {
      emailVerifyButtonEl.disabled = false;
    }
    if (!result?.sessionToken) {
      setOtpError("Сервер не вернул сессию. Повторите вход.");
      return;
    }

    applyAuthResult(result);
    clearResendTimer();
    showMainScreen();
    renderLineTabs();
    updateLineToggleUI();
    persistCurrentLinePreference();
    loadInitialData();
  });

  emailResendButtonEl?.addEventListener("click", async () => {
    if (emailAuthState.resendRemaining > 0) return;
    clearAuthErrors();
    if (!emailAuthState.targetEmail) {
      if (emailCodeErrorEl) emailCodeErrorEl.textContent = "Сначала запросите код";
      return;
    }
    const ok = await requestAuthCode(emailCodeErrorEl);
    if (ok) startResendTimer();
  });
}

function initTheme() {
  applyThemeConfigVariables();

  const storedTheme = localStorage.getItem(STORAGE_KEYS.theme);
  const preferredTheme = storedTheme === "light" ? "light" : "dark";
  applyTheme(preferredTheme);

  if (btnThemeToggleEl) {
    btnThemeToggleEl.addEventListener("click", () => {
      const next = state.ui.theme === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  }
}

function applyTheme(theme) {
  state.ui.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEYS.theme, theme);
  updateThemeToggleUI();
  applyCalendarUiTheme(theme);

  // Обновление цветов при смене темы
  if (typeof ShiftColors !== 'undefined' && ShiftColors.applyTheme) {
    ShiftColors.applyTheme(theme);
  }
}

function applyCalendarUiTheme(theme) {
  const calendarUi = config.calendar?.ui ?? {};
  const themeKey = theme === "light" ? "light" : "dark";
  const themeConfig = calendarUi[themeKey] ?? calendarUi.light ?? {};
  const rootStyle = document.documentElement.style;

  const setVar = (name, value) => {
    if (typeof value === "string") rootStyle.setProperty(name, value);
  };

  const applyDayVars = (type, values) => {
    if (!values) return;
    setVar(`--calendar-${type}-bg`, values.background);
    setVar(`--calendar-${type}-border`, values.border);
    setVar(`--calendar-${type}-dash`, values.dash);
  };

  applyDayVars("workday", themeConfig.workday);
  applyDayVars("weekend", themeConfig.weekend);
  applyDayVars("holiday", themeConfig.holiday);
  applyDayVars("preholiday", themeConfig.preholiday);

  const micro = themeConfig.microIndicators ?? {};
  setVar("--calendar-micro-weekend", micro.weekend);
  setVar("--calendar-micro-holiday", micro.holiday);
  setVar("--calendar-micro-preholiday", micro.preholiday);
}

function updateThemeToggleUI() {
  if (!btnThemeToggleEl) return;
  const isDark = state.ui.theme === "dark";
  btnThemeToggleEl.textContent = isDark ? "🌙 Тема" : "☀️ Тема";
  btnThemeToggleEl.setAttribute(
    "aria-label",
    isDark ? "Включена тёмная тема" : "Включена светлая тема"
  );
}

function loadCurrentLinePreference() {
  try {
    const storedLine = localStorage.getItem(STORAGE_KEYS.currentLine);
    if (storedLine && LINE_KEYS_IN_UI_ORDER.includes(storedLine)) {
      state.ui.currentLine = storedLine;
    }
  } catch (_) {
    // ignore storage quota / privacy mode
  }
}

function persistCurrentLinePreference() {
  try {
    localStorage.setItem(STORAGE_KEYS.currentLine, state.ui.currentLine);
  } catch (_) {
    // ignore storage quota / privacy mode
  }
}

function getMonthKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

function loadCachedEmployees() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.cachedEmployees);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return false;

    const employeesByLine = cached.employeesByLine;
    if (!employeesByLine || typeof employeesByLine !== "object") return false;

    for (const key of Object.keys(state.employeesByLine)) {
      const list = employeesByLine[key];
      state.employeesByLine[key] = Array.isArray(list) ? list : [];
    }
    return true;
  } catch (err) {
    console.warn("Не удалось загрузить кэш сотрудников", err);
    return false;
  }
}

function persistCachedEmployees() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.cachedEmployees,
      JSON.stringify({
        fetchedAt: Date.now(),
        employeesByLine: state.employeesByLine,
      })
    );
  } catch (err) {
    console.warn("Не удалось сохранить кэш сотрудников", err);
  }
}

function loadCachedShiftTemplates() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.cachedShiftTemplates);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return false;

    const templatesByLine = cached.shiftTemplatesByLine;
    if (!templatesByLine || typeof templatesByLine !== "object") return false;

    for (const key of Object.keys(state.shiftTemplatesByLine)) {
      const list = templatesByLine[key];
      state.shiftTemplatesByLine[key] = Array.isArray(list) ? list : [];
    }

    if (typeof ShiftColors !== "undefined" && ShiftColors.initialize) {
      ShiftColors.initialize(state.shiftTemplatesByLine, state.ui.theme);
    }
    return true;
  } catch (err) {
    console.warn("Не удалось загрузить кэш шаблонов смен", err);
    return false;
  }
}

function persistCachedShiftTemplates() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.cachedShiftTemplates,
      JSON.stringify({
        fetchedAt: Date.now(),
        shiftTemplatesByLine: state.shiftTemplatesByLine,
      })
    );
  } catch (err) {
    console.warn("Не удалось сохранить кэш шаблонов смен", err);
  }
}

function loadCachedScheduleForMonth(year, monthIndex) {
  try {
    const monthKey = getMonthKey(year, monthIndex);
    const raw = localStorage.getItem(`${STORAGE_KEYS.cachedSchedulePrefix}${monthKey}`);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return false;
    if (!cached.scheduleByLine || typeof cached.scheduleByLine !== "object") return false;

    state.scheduleByLine = cached.scheduleByLine;
    state.originalScheduleByLine = deepClone(cached.scheduleByLine);
    state.vacationsByEmployee = cached.vacationsByEmployee || {};
    state.ui.isScheduleCached = true;

    applyLocalChangesToSchedule();
    renderScheduleCurrentLine();
    return true;
  } catch (err) {
    console.warn("Не удалось загрузить кэш графика", err);
    return false;
  }
}

function persistCachedScheduleForMonth(year, monthIndex) {
  try {
    const monthKey = getMonthKey(year, monthIndex);
    localStorage.setItem(
      `${STORAGE_KEYS.cachedSchedulePrefix}${monthKey}`,
      JSON.stringify({
        fetchedAt: Date.now(),
        scheduleByLine: state.scheduleByLine,
        vacationsByEmployee: state.vacationsByEmployee,
      })
    );
  } catch (err) {
    console.warn("Не удалось сохранить кэш графика", err);
  }
}

function loadEmployeeFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.employeeFilters);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    for (const key of Object.keys(state.employeeFiltersByLine)) {
      const list = parsed[key];
      if (Array.isArray(list)) {
        state.employeeFiltersByLine[key] = list
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id));
      }
    }
  } catch (err) {
    console.warn("Не удалось загрузить фильтры сотрудников", err);
  }
}

function persistEmployeeFilters() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.employeeFilters,
      JSON.stringify(state.employeeFiltersByLine)
    );
  } catch (err) {
    console.warn("Не удалось сохранить фильтры сотрудников", err);
  }
}

function normalizeHiddenEmployeeIds(line, rows) {
  const validIds = new Set(rows.map((row) => row.employeeId));
  const current = state.employeeFiltersByLine[line] || [];
  const next = current.filter((id) => validIds.has(id));
  if (next.length !== current.length) {
    state.employeeFiltersByLine[line] = next;
    persistEmployeeFilters();
  }
  return new Set(next);
}

function setHiddenEmployeeIds(line, ids) {
  state.employeeFiltersByLine[line] = Array.from(ids);
  persistEmployeeFilters();
}

function createEmployeeFilterPopover() {
  if (employeeFilterPopoverEl) return;

  employeeFilterPopoverBackdropEl = document.createElement("div");
  employeeFilterPopoverBackdropEl.className = "employee-filter-popover-backdrop hidden";

  employeeFilterPopoverEl = document.createElement("div");
  employeeFilterPopoverEl.className = "employee-filter-popover hidden";

  const header = document.createElement("div");
  header.className = "employee-filter-popover-header";

  employeeFilterPopoverTitleEl = document.createElement("div");
  employeeFilterPopoverTitleEl.className = "employee-filter-header";
  employeeFilterPopoverTitleEl.textContent = "Фильтр сотрудников";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "employee-filter-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Закрыть фильтр сотрудников");

  header.appendChild(employeeFilterPopoverTitleEl);
  header.appendChild(closeBtn);

  employeeFilterPopoverMetaEl = document.createElement("div");
  employeeFilterPopoverMetaEl.className = "employee-filter-meta";

  employeeFilterPopoverListEl = document.createElement("div");
  employeeFilterPopoverListEl.className = "employee-filter-list";

  employeeFilterPopoverControlsEl = document.createElement("div");
  employeeFilterPopoverControlsEl.className = "employee-filter-controls";

  employeeFilterPopoverEl.appendChild(header);
  employeeFilterPopoverEl.appendChild(employeeFilterPopoverMetaEl);
  employeeFilterPopoverEl.appendChild(employeeFilterPopoverListEl);
  employeeFilterPopoverEl.appendChild(employeeFilterPopoverControlsEl);

  employeeFilterPopoverBackdropEl.appendChild(employeeFilterPopoverEl);
  document.body.appendChild(employeeFilterPopoverBackdropEl);

  const closeHandler = () => closeEmployeeFilterPopover();
  employeeFilterPopoverBackdropEl.addEventListener("click", (event) => {
    if (event.target === employeeFilterPopoverBackdropEl) {
      closeHandler();
    }
  });
  closeBtn.addEventListener("click", closeHandler);
}

function closeEmployeeFilterPopover() {
  if (!employeeFilterPopoverEl || !employeeFilterPopoverBackdropEl) return;
  employeeFilterPopoverBackdropEl.classList.add("hidden");
  employeeFilterPopoverEl.classList.add("hidden");
  if (employeeFilterPopoverKeydownHandler) {
    document.removeEventListener("keydown", employeeFilterPopoverKeydownHandler);
    employeeFilterPopoverKeydownHandler = null;
  }
}

function createLineTabsPopover() {
  if (lineTabsPopoverEl) return;

  lineTabsPopoverBackdropEl = document.createElement("div");
  lineTabsPopoverBackdropEl.className = "line-tabs-popover-backdrop hidden";

  lineTabsPopoverEl = document.createElement("div");
  lineTabsPopoverEl.className = "line-tabs-popover hidden";

  const header = document.createElement("div");
  header.className = "line-tabs-popover-header";

  const title = document.createElement("div");
  title.className = "line-tabs-popover-title";
  title.textContent = "Отделы";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "line-tabs-popover-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Закрыть список отделов");

  lineTabsPopoverListEl = document.createElement("div");
  lineTabsPopoverListEl.className = "line-tabs-popover-list";

  header.appendChild(title);
  header.appendChild(closeBtn);
  lineTabsPopoverEl.appendChild(header);
  lineTabsPopoverEl.appendChild(lineTabsPopoverListEl);
  lineTabsPopoverBackdropEl.appendChild(lineTabsPopoverEl);
  document.body.appendChild(lineTabsPopoverBackdropEl);

  const closeHandler = () => closeLineTabsPopover();
  closeBtn.addEventListener("click", closeHandler);
  lineTabsPopoverBackdropEl.addEventListener("click", (event) => {
    if (event.target === lineTabsPopoverBackdropEl) {
      closeHandler();
    }
  });
}

function openLineTabsPopover() {
  if (!lineTabsPopoverBackdropEl || !lineTabsPopoverEl) return;
  lineTabsPopoverBackdropEl.classList.remove("hidden");
  lineTabsPopoverEl.classList.remove("hidden");
  document.body.classList.add("line-tabs-open");
  if (!lineTabsPopoverKeydownHandler) {
    lineTabsPopoverKeydownHandler = (event) => {
      if (event.key === "Escape") {
        closeLineTabsPopover();
      }
    };
  }
  document.addEventListener("keydown", lineTabsPopoverKeydownHandler);
}

function closeLineTabsPopover() {
  if (!lineTabsPopoverBackdropEl || !lineTabsPopoverEl) return;
  lineTabsPopoverBackdropEl.classList.add("hidden");
  lineTabsPopoverEl.classList.add("hidden");
  document.body.classList.remove("line-tabs-open");
  if (lineTabsPopoverKeydownHandler) {
    document.removeEventListener("keydown", lineTabsPopoverKeydownHandler);
    lineTabsPopoverKeydownHandler = null;
  }
}

function openEmployeeFilterPopover({
  line,
  rows,
  hiddenEmployeeIds,
  table,
  emptyRow,
  onUpdateButton,
}) {
  if (!employeeFilterPopoverEl || !employeeFilterPopoverBackdropEl) return;

  employeeFilterPopoverListEl.innerHTML = "";
  employeeFilterPopoverControlsEl.innerHTML = "";

  const masterLabel = document.createElement("label");
  masterLabel.className = "employee-filter-item employee-filter-master";
  const masterCheckbox = document.createElement("input");
  masterCheckbox.type = "checkbox";
  const masterText = document.createElement("span");
  masterText.textContent = "Все сотрудники";
  masterLabel.appendChild(masterCheckbox);
  masterLabel.appendChild(masterText);
  employeeFilterPopoverListEl.appendChild(masterLabel);

  const itemCheckboxes = [];

  for (const row of rows) {
    const itemLabel = document.createElement("label");
    itemLabel.className = "employee-filter-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !hiddenEmployeeIds.has(row.employeeId);
    checkbox.dataset.employeeId = String(row.employeeId);

    const name = document.createElement("span");
    name.textContent = row.employeeName;

    itemLabel.appendChild(checkbox);
    itemLabel.appendChild(name);
    employeeFilterPopoverListEl.appendChild(itemLabel);
    itemCheckboxes.push(checkbox);
  }

  const updateFilterUI = () => {
    const total = rows.length;
    const hiddenCount = hiddenEmployeeIds.size;
    const visibleCount = total - hiddenCount;
    masterCheckbox.checked = hiddenCount === 0;
    masterCheckbox.indeterminate = hiddenCount > 0 && hiddenCount < total;
    employeeFilterPopoverMetaEl.textContent = `Показано: ${visibleCount} из ${total}`;
    if (onUpdateButton) onUpdateButton();
  };

  masterCheckbox.addEventListener("change", () => {
    if (masterCheckbox.checked) {
      hiddenEmployeeIds.clear();
    } else {
      for (const row of rows) {
        hiddenEmployeeIds.add(row.employeeId);
      }
    }
    for (const checkbox of itemCheckboxes) {
      const id = Number(checkbox.dataset.employeeId);
      checkbox.checked = !hiddenEmployeeIds.has(id);
    }
    setHiddenEmployeeIds(line, hiddenEmployeeIds);
    updateFilterUI();
    applyEmployeeFilterToTable(table, hiddenEmployeeIds, emptyRow);
  });

  for (const checkbox of itemCheckboxes) {
    checkbox.addEventListener("change", () => {
      const id = Number(checkbox.dataset.employeeId);
      if (checkbox.checked) {
        hiddenEmployeeIds.delete(id);
      } else {
        hiddenEmployeeIds.add(id);
      }
      setHiddenEmployeeIds(line, hiddenEmployeeIds);
      updateFilterUI();
      applyEmployeeFilterToTable(table, hiddenEmployeeIds, emptyRow);
    });
  }

  const closeControl = document.createElement("button");
  closeControl.type = "button";
  closeControl.className = "employee-filter-close-action";
  closeControl.textContent = "Закрыть";
  closeControl.addEventListener("click", closeEmployeeFilterPopover);
  employeeFilterPopoverControlsEl.appendChild(closeControl);

  updateFilterUI();

  employeeFilterPopoverBackdropEl.classList.remove("hidden");
  employeeFilterPopoverEl.classList.remove("hidden");
  employeeFilterPopoverKeydownHandler = (event) => {
    if (event.key === "Escape") {
      closeEmployeeFilterPopover();
    }
  };
  document.addEventListener("keydown", employeeFilterPopoverKeydownHandler);
}

// -----------------------------
// События
// -----------------------------

function setCurrentLine(lineKey) {
  if (!canViewLine(lineKey)) return;
  state.ui.currentLine = lineKey;
  persistCurrentLinePreference();
  updateLineToggleUI();
  updateSaveButtonState();
  updateQuickModeForLine();
  renderQuickTemplateOptions();
  renderScheduleCurrentLine();
  if (typeof ShiftColors !== 'undefined' && ShiftColors.renderColorLegend) {
    ShiftColors.renderColorLegend(state.ui.currentLine);
  }
}

function renderLineTabs() {
  if (!lineTabsEl) return;
  lineTabsEl.innerHTML = "";
  createLineTabsPopover();
  if (lineTabsPopoverListEl) lineTabsPopoverListEl.innerHTML = "";
  for (const key of LINE_KEYS_IN_UI_ORDER) {
    if (!canViewLine(key)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn toggle";
    btn.dataset.line = key;
    btn.textContent = LINE_LABELS[key] || key;
    btn.addEventListener("click", () => {
      document.body.classList.remove("mobile-toolbar-open");
      setCurrentLine(key);
    });
    lineTabsEl.appendChild(btn);

    if (lineTabsPopoverListEl) {
      const popoverBtn = document.createElement("button");
      popoverBtn.type = "button";
      popoverBtn.className = "btn toggle";
      popoverBtn.dataset.line = key;
      popoverBtn.textContent = LINE_LABELS[key] || key;
      popoverBtn.addEventListener("click", () => {
        setCurrentLine(key);
        closeLineTabsPopover();
      });
      lineTabsPopoverListEl.appendChild(popoverBtn);
    }
  }
  updateLineToggleUI();
}

function setLegendOpen(isOpen) {
  if (!shiftLegendEl) return;
  if (window.innerWidth > 768) {
    shiftLegendEl.classList.remove("shift-legend-hidden", "shift-legend-modal");
    document.body.classList.remove("legend-open");
    btnLegendToggleEl?.setAttribute("aria-expanded", "true");
    shiftLegendBackdropEl?.setAttribute("aria-hidden", "true");
    if (legendKeydownHandler) {
      document.removeEventListener("keydown", legendKeydownHandler);
      legendKeydownHandler = null;
    }
    return;
  }
  shiftLegendEl.classList.toggle("shift-legend-hidden", !isOpen);
  shiftLegendEl.classList.toggle("shift-legend-modal", isOpen);
  document.body.classList.toggle("legend-open", isOpen);
  btnLegendToggleEl?.setAttribute("aria-expanded", String(isOpen));
  shiftLegendBackdropEl?.setAttribute("aria-hidden", String(!isOpen));

  if (isOpen) {
    if (!legendKeydownHandler) {
      legendKeydownHandler = (event) => {
        if (event.key === "Escape") {
          setLegendOpen(false);
        }
      };
    }
    document.addEventListener("keydown", legendKeydownHandler);
  } else if (legendKeydownHandler) {
    document.removeEventListener("keydown", legendKeydownHandler);
  }
}

function bindTopBarButtons() {
  renderLineTabs();
  setLegendOpen(window.innerWidth <= 768 ? false : true);
  updateScheduleStickyOffsets();

  // Mobile bottom-sheet controls
  btnMobileToolbarEl?.addEventListener("click", () => {
    document.body.classList.toggle("mobile-toolbar-open");
  });
  btnMobileToolbarCloseEl?.addEventListener("click", () => {
    document.body.classList.remove("mobile-toolbar-open");
  });
  btnLineTabsEl?.addEventListener("click", () => {
    const isOpen = !document.body.classList.contains("line-tabs-open");
    if (isOpen) openLineTabsPopover();
    else closeLineTabsPopover();
  });
  btnLegendToggleEl?.addEventListener("click", () => {
    const isOpen = !document.body.classList.contains("legend-open");
    setLegendOpen(isOpen);
  });
  shiftLegendBackdropEl?.addEventListener("click", () => {
    setLegendOpen(false);
  });
  currentMonthLabelEl?.addEventListener("click", () => {
    openMonthPickerPopover();
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      closeLineTabsPopover();
      setLegendOpen(true);
    } else {
      setLegendOpen(false);
    }
    updateScheduleStickyOffsets();
  });

  btnLogoutEl?.addEventListener("click", () => {
    apiClient.call("auth.logout", {}).catch(() => {});
    resetAuthState();

    showLoginScreen();
    clearAuthErrors();
    updateLineToggleUI();
  });
btnPrevMonthEl.addEventListener("click", () => {
    const { year, monthIndex } = state.monthMeta;
    const date = new Date(Date.UTC(year, monthIndex, 1));
    date.setMonth(monthIndex - 1);
    state.monthMeta.year = date.getUTCFullYear();
    state.monthMeta.monthIndex = date.getUTCMonth();
    updateMonthLabel();
    reloadScheduleForCurrentMonth();
  });

  btnNextMonthEl.addEventListener("click", () => {
    const { year, monthIndex } = state.monthMeta;
    const date = new Date(Date.UTC(year, monthIndex, 1));
    date.setMonth(monthIndex + 1);
    state.monthMeta.year = date.getUTCFullYear();
    state.monthMeta.monthIndex = date.getUTCMonth();
    updateMonthLabel();
    reloadScheduleForCurrentMonth();
  });

  updateLineToggleUI();

  // Отображение легенды цветов при переключении линии
  if (typeof ShiftColors !== 'undefined' && ShiftColors.renderColorLegend) {
    ShiftColors.renderColorLegend(state.ui.currentLine);
  }

}

function updateLineToggleUI() {
  const line = state.ui.currentLine;
  if (!lineTabsEl) return;
  const buttons = lineTabsEl.querySelectorAll('button[data-line]');
  buttons.forEach((b) => {
    if (b.dataset.line === line) b.classList.add("active");
    else b.classList.remove("active");
  });
  const popoverButtons = lineTabsPopoverListEl?.querySelectorAll('button[data-line]') || [];
  popoverButtons.forEach((b) => {
    if (b.dataset.line === line) b.classList.add("active");
    else b.classList.remove("active");
  });
}


function bindHistoryControls() {
  if (btnClearHistoryEl) {
    btnClearHistoryEl.addEventListener("click", () => {
      state.changeHistory = [];
      persistChangeHistory();
      renderChangeLog();
    });
  }

  if (btnSavePyrusEl) {
    btnSavePyrusEl.addEventListener("click", handleSaveToPyrus);
  }
}

function initQuickAssignPanel() {
  renderQuickTemplateOptions();
  syncQuickPanelInputs();
  updateQuickModeToggleUI();

  if (state.ui.quickPanelBound) return;

  quickTemplateSelectEl?.addEventListener("change", () => {
    const val = quickTemplateSelectEl.value;
    state.quickMode.templateId = val ? Number(val) : null;

    const tmpl = getCurrentLineTemplates().find(
      (t) => t.id === state.quickMode.templateId
    );
    if (tmpl?.timeRange) {
      state.quickMode.timeFrom = tmpl.timeRange.start;
      state.quickMode.timeTo = tmpl.timeRange.end;
      syncQuickPanelInputs();
    }
    if (tmpl && typeof tmpl.amount === "number") {
      state.quickMode.amount = tmpl.amount;
      syncQuickPanelInputs();
    }
  });

  quickTimeFromInputEl?.addEventListener("input", (e) => {
    state.quickMode.timeFrom = e.target.value;
  });

  quickTimeToInputEl?.addEventListener("input", (e) => {
    state.quickMode.timeTo = e.target.value;
  });

  quickAmountInputEl?.addEventListener("input", (e) => {
    state.quickMode.amount = e.target.value;
  });

  quickModeToggleEl?.addEventListener("click", () => {
    const currentLine = state.ui.currentLine;
    
    if (state.ui.isScheduleCached) {
      alert("Данные загружаются, редактирование временно недоступно.");
      return;
    }

    if (!canEditLine(currentLine)) {
      alert(`У вас нет прав на редактирование линии ${currentLine}`);
      return;
    }
    
    state.quickMode.enabled = !state.quickMode.enabled;
    updateQuickModeToggleUI();
  });

  state.ui.quickPanelBound = true;
}

function renderQuickTemplateOptions() {
  if (!quickTemplateSelectEl) return;

  const currentLineTemplates = getCurrentLineTemplates();
  const prevSelected = state.quickMode.templateId;

  quickTemplateSelectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Шаблон не выбран";
  quickTemplateSelectEl.appendChild(placeholder);

  currentLineTemplates.forEach((tmpl) => {
    const option = document.createElement("option");
    option.value = String(tmpl.id);
    const timeLabel = tmpl.timeRange
      ? ` (${tmpl.timeRange.start}–${tmpl.timeRange.end})`
      : "";
    option.textContent = `${tmpl.name}${timeLabel}`;
    quickTemplateSelectEl.appendChild(option);
  });

  const hasPrev = currentLineTemplates.some((t) => t.id === prevSelected);
  quickTemplateSelectEl.value = hasPrev ? String(prevSelected) : "";
  state.quickMode.templateId = hasPrev ? prevSelected : null;
}

function syncQuickPanelInputs() {
  if (quickTimeFromInputEl) {
    quickTimeFromInputEl.value = state.quickMode.timeFrom || "";
  }
  if (quickTimeToInputEl) {
    quickTimeToInputEl.value = state.quickMode.timeTo || "";
  }
  if (quickAmountInputEl) {
    quickAmountInputEl.value =
      state.quickMode.amount !== undefined && state.quickMode.amount !== null
        ? state.quickMode.amount
        : "";
  }
}

function updateQuickModeToggleUI() {
  if (!quickModeToggleEl) return;
  quickModeToggleEl.classList.toggle("active", state.quickMode.enabled);
  quickModeToggleEl.textContent = state.quickMode.enabled
    ? "Быстрое назначение: Вкл"
    : "Быстрое назначение";
}

function updateQuickModeForLine() {
  const currentLine = state.ui.currentLine;
  const lineLabel = LINE_LABELS[currentLine] || currentLine;
  const canEdit = canEditLine(currentLine);
  const isCached = state.ui.isScheduleCached;
  
  if (!canEdit && state.quickMode.enabled) {
    state.quickMode.enabled = false;
    updateQuickModeToggleUI();
  }
  
  if (quickModeToggleEl) {
    quickModeToggleEl.disabled = !canEdit;
    quickModeToggleEl.title = canEdit 
      ? "Включить быстрое назначение смен"
      : isCached
      ? "Данные загружаются, редактирование временно недоступно"
      : `Нет прав на редактирование ${lineLabel}`;
  }
  
  if (quickTemplateSelectEl) {
    quickTemplateSelectEl.disabled = !canEdit;
  }
  
  if (quickTimeFromInputEl) {
    quickTimeFromInputEl.disabled = !canEdit;
  }
  
  if (quickTimeToInputEl) {
    quickTimeToInputEl.disabled = !canEdit;
  }
  
  if (quickAmountInputEl) {
    quickAmountInputEl.disabled = !canEdit;
  }
}

function countChangesForLine(line) {
  const { year, monthIndex } = state.monthMeta;
  let count = 0;
  
  const prefix = `${line}-${year}-${monthIndex + 1}-`;
  for (const key in state.localChanges) {
    if (key.startsWith(prefix)) {
      count++;
    }
  }
  
  return count;
}

function updateSaveButtonState() {
  if (!btnSavePyrusEl) return;
  
  const currentLine = state.ui.currentLine;
  const lineLabel = LINE_LABELS[currentLine] || currentLine;
  const canEdit = canEditLine(currentLine);
  const changesCount = countChangesForLine(currentLine);
  const isCached = state.ui.isScheduleCached;
  
  if (!canEdit) {
    btnSavePyrusEl.textContent = isCached
      ? `Данные загружаются (${lineLabel})`
      : `Нет прав на ${lineLabel}`;
    btnSavePyrusEl.disabled = true;
    btnSavePyrusEl.title = isCached
      ? "Сейчас отображается кэш, редактирование временно отключено."
      : `У вас только просмотр для вкладки ${lineLabel}`;
  } else if (changesCount === 0) {
    btnSavePyrusEl.textContent = `Нет изменений (${lineLabel})`;
    btnSavePyrusEl.disabled = true;
    btnSavePyrusEl.title = `Нет несохранённых изменений для вкладки ${lineLabel}`;
  } else {
    btnSavePyrusEl.textContent = `Сохранить ${lineLabel} (${changesCount})`;
    btnSavePyrusEl.disabled = false;
    btnSavePyrusEl.title = `Сохранить ${changesCount} изменений для вкладки ${lineLabel}`;
  }
}

function getQuickModeShift(line) {
  const templates = state.shiftTemplatesByLine[line] || [];
  const tmpl = templates.find((t) => t.id === state.quickMode.templateId);

  let startLocal = state.quickMode.timeFrom;
  let endLocal = state.quickMode.timeTo;

  if ((!startLocal || !endLocal) && tmpl?.timeRange) {
    startLocal = tmpl.timeRange.start;
    endLocal = tmpl.timeRange.end;
  }

  let amount = state.quickMode.amount;
  if (amount === "" || amount === undefined || amount === null) {
    amount = tmpl?.amount ?? 0;
  }

  return {
    startLocal,
    endLocal,
    amount: Number(amount || 0),
    templateId: tmpl?.id ?? null,
    specialShortLabel: tmpl?.specialShortLabel || null,
  };
}

function resolveSpecialShortLabel(line, templateId) {
  if (!line || templateId == null) return null;
  const templates = state.shiftTemplatesByLine[line] || [];
  const tmpl = templates.find((t) => t.id === templateId);
  return tmpl?.specialShortLabel || null;
}

function logChange({
  action,
  line,
  employeeId,
  employeeName,
  day,
  previousShift,
  nextShift,
}) {
  const { year, monthIndex } = state.monthMeta;
  const date = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(
    2,
    "0"
  )}`;
  const entry = {
    id: `${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    action,
    line,
    employeeId,
    employeeName,
    date,
    previousShift: previousShift
      ? {
          startLocal: previousShift.startLocal || "",
          endLocal: previousShift.endLocal || "",
          amount: Number(previousShift.amount || 0),
        }
      : null,
    nextShift: nextShift
      ? {
          startLocal: nextShift.startLocal || "",
          endLocal: nextShift.endLocal || "",
          amount: Number(nextShift.amount || 0),
        }
      : null,
  };

  state.changeHistory.unshift(entry);
  if (state.changeHistory.length > 300) {
    state.changeHistory.length = 300;
  }

  persistChangeHistory();
  renderChangeLog();
  updateSaveButtonState();
}

function shiftsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const normalizeAmount = (val) => Number(val || 0);
  const normalizeTemplate = (val) => (val != null ? Number(val) : null);
  const normalizeIso = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
  };

  const normDuration = (shift) => {
    if (shift?.durationMinutes != null) return Number(shift.durationMinutes);
    const duration = computeDurationMinutes(
      shift?.startLocal,
      shift?.endLocal
    );
    return duration == null ? null : duration;
  };

  return (
    (a.startLocal || "") === (b.startLocal || "") &&
    (a.endLocal || "") === (b.endLocal || "") &&
    normalizeAmount(a.amount) === normalizeAmount(b.amount) &&
    normalizeTemplate(a.templateId) === normalizeTemplate(b.templateId) &&
    normalizeIso(a.startUtcIso) === normalizeIso(b.startUtcIso) &&
    normalizeIso(a.endUtcIso) === normalizeIso(b.endUtcIso) &&
    normDuration(a) === normDuration(b)
  );
}

function buildPyrusChangesPayload(lineToSave = null) {
  const result = {
    create: { task: [] },
    deleted: { task: [] },
    edit: { task: [] },
  };

  const linesToProcess = lineToSave && lineToSave !== "ALL" ? [lineToSave] : LINE_KEYS;

  for (const line of linesToProcess) {
    const baseSched = state.originalScheduleByLine[line];
    const currentSched = state.scheduleByLine[line];
    if (!currentSched || !currentSched.days || !currentSched.rows) continue;

    const baseRowByEmployee = Object.create(null);
    if (baseSched && Array.isArray(baseSched.rows)) {
      for (const row of baseSched.rows) {
        baseRowByEmployee[row.employeeId] = row;
      }
    }

    currentSched.rows.forEach((row) => {
      const baseRow = baseRowByEmployee[row.employeeId];

      // Подразделение смены = вкладка, в которой её редактируют
      const departmentItemId = getDepartmentItemIdForLine(line);

      currentSched.days.forEach((day, idx) => {
        const baseShift = baseRow ? baseRow.shiftsByDay[idx] || null : null;
        const currentShift = row.shiftsByDay[idx] || null;

        if (!baseShift && !currentShift) return;

        if (!baseShift && currentShift) {
          const conversion =
            currentShift.startUtcIso && currentShift.durationMinutes != null
              ? {
                  startUtcIso: currentShift.startUtcIso,
                  durationMinutes: Number(currentShift.durationMinutes),
                }
              : convertLocalRangeToUtc(
                  day,
                  currentShift.startLocal,
                  currentShift.endLocal
                );
          if (!conversion) return;

          result.create.task.push({
            employee_id: row.employeeId,
            item_id: currentShift.templateId ?? null,
            start: conversion.startUtcIso,
            duration: conversion.durationMinutes,
            amount: Number(currentShift.amount || 0),
            department_item_id: departmentItemId,
          });
          return;
        }

        if (baseShift && !currentShift) {
          if (baseShift.taskId) {
            result.deleted.task.push({ task_id: baseShift.taskId });
          }
          return;
        }

        if (baseShift && currentShift && !shiftsEqual(baseShift, currentShift)) {
          const conversion =
            currentShift.startUtcIso && currentShift.durationMinutes != null
              ? {
                  startUtcIso: currentShift.startUtcIso,
                  durationMinutes: Number(currentShift.durationMinutes),
                }
              : convertLocalRangeToUtc(
                  day,
                  currentShift.startLocal,
                  currentShift.endLocal
                );
          if (!conversion) return;

          result.edit.task.push({
            task_id: baseShift.taskId,
            employee_id: row.employeeId,
            item_id: currentShift.templateId ?? baseShift.templateId ?? null,
            start: conversion.startUtcIso,
            duration: conversion.durationMinutes,
            amount: Number(currentShift.amount || 0),
            department_item_id: departmentItemId,
          });
        }
      });
    });
  }

  return result;
}

async function handleSaveToPyrus() {
  if (!btnSavePyrusEl) return;

  const currentLine = state.ui.currentLine;
  
  if (currentLine === "ALL" || !canEditLine(currentLine)) {
    alert(`Сохранение доступно во вкладке подразделения, где у вас есть права редактора`);
    return;
  }
  if (getDepartmentItemIdForLine(currentLine) == null) {
    alert(`Не найден элемент справочника подразделений для вкладки ${LINE_LABELS[currentLine] || currentLine}`);
    return;
  }

  const payload = buildPyrusChangesPayload(currentLine);
  
  const hasChanges = 
    payload.create.task.length > 0 ||
    payload.deleted.task.length > 0 ||
    payload.edit.task.length > 0;
  
  if (!hasChanges) {
    alert(`Нет изменений для сохранения во вкладке ${LINE_LABELS[currentLine] || currentLine}`);
    return;
  }
  
  btnSavePyrusEl.disabled = true;
  btnSavePyrusEl.textContent = "Сохранение...";

  try {
    const meta = {
      line: currentLine,
      month: state.monthMeta.monthIndex + 1,
      year: state.monthMeta.year,
    };
    
    const saveResult = (await apiClient.call("schedule.save", { changes: payload, meta })) || {};
    scheduleService.applySaveResult?.(saveResult);
    const created = saveResult.created ?? payload.create.task.length;
    const edited = saveResult.edited ?? payload.edit.task.length;
    const deleted = saveResult.deleted ?? payload.deleted.task.length;
    showAppToast(
      `Pyrus: ${LINE_LABELS[currentLine] || currentLine} • создано ${created}, изменено ${edited}, удалено ${deleted}`
    );
    if (Array.isArray(saveResult.errors) && saveResult.errors.length) {
      console.warn("schedule.save errors", saveResult.errors);
      alert(
        `Часть изменений не сохранилась (${saveResult.errors.length}):\n` +
          saveResult.errors.slice(0, 5).map((e) => `• ${e.op}: ${e.message}`).join("\n")
      );
    }
    
    state.originalScheduleByLine[currentLine] = deepClone(state.scheduleByLine[currentLine]);
    
    const { year, monthIndex } = state.monthMeta;
    const prefix = `${currentLine}-${year}-${monthIndex + 1}-`;
    for (const key in state.localChanges) {
      if (key.startsWith(prefix)) {
        delete state.localChanges[key];
      }
    }
    persistLocalChanges();
    
    updateSaveButtonState();

    const monthKey = getMonthKey(state.monthMeta.year, state.monthMeta.monthIndex);
    scheduleService.invalidateMonthSchedule(monthKey);
    await reloadScheduleForCurrentMonth();
    
  } catch (err) {
    console.error("handleSaveToPyrus error", err);
    alert(`Не удалось отправить в Pyrus: ${err.message || err}`);
  } finally {
    btnSavePyrusEl.disabled = false;
    btnSavePyrusEl.textContent = "Сохранить в Pyrus";
  }
}

function renderChangeLog() {
  if (!changeLogListEl) return;

  changeLogListEl.innerHTML = "";

  if (!state.changeHistory.length) {
    changeLogListEl.textContent = "Пока нет локальных изменений";
    changeLogListEl.classList.add("change-log-empty");
    return;
  }

  changeLogListEl.classList.remove("change-log-empty");
  const actionLabels = {
    create: "Добавлена смена",
    update: "Изменена смена",
    delete: "Удалена смена",
  };

  const formatShift = (shift) => {
    if (!shift) return "—";
    const amountLabel = shift.amount ? `${shift.amount.toLocaleString("ru-RU")} ₽` : "";
    return `${shift.startLocal}–${shift.endLocal}${amountLabel ? ` · ${amountLabel}` : ""}`;
  };

  state.changeHistory.forEach((entry) => {
    const wrapper = document.createElement("div");
    wrapper.className = "change-log-entry";

    const title = document.createElement("div");
    const actionLabel = actionLabels[entry.action] || "Изменение";
    const time = new Date(entry.timestamp).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    title.textContent = `${actionLabel} • ${entry.date} • ${time}`;

    const details = document.createElement("div");
    details.textContent = `${entry.employeeName} (${LINE_LABELS[entry.line] || entry.line})`;

    const shiftLine = document.createElement("div");
    shiftLine.textContent = `Было: ${formatShift(entry.previousShift)} → Стало: ${formatShift(
      entry.nextShift
    )}`;

    wrapper.appendChild(title);
    wrapper.appendChild(details);
    wrapper.appendChild(shiftLine);
    changeLogListEl.appendChild(wrapper);
  });
}

function handleShiftCellClick({ line, row, day, dayIndex, shift, cellEl }) {
  if (!canEditLine(line)) {
    openShiftPopoverReadOnly(
      {
        line,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        day,
        shift: shift || null,
      },
      cellEl
    );
    return;
  }

  if (state.quickMode.enabled) {
    const { startLocal, endLocal, amount, templateId, specialShortLabel } =
      getQuickModeShift(line);

    // input[type=time] принимает только HH:MM, поэтому нормализуем,
    // иначе браузер может вернуть пустое значение и дальше сломается конвертация.
    const normStartLocal = normalizeTimeHHMM(startLocal);
    const normEndLocal = normalizeTimeHHMM(endLocal);

    if (!normStartLocal || !normEndLocal) {
      alert(
        "Укажите время начала и конца смены в панели быстрого назначения."
      );
      return;
    }

    const { year, monthIndex } = state.monthMeta;
    const sched = state.scheduleByLine[line];
    const resolvedDayIndex =
      typeof dayIndex === "number" && dayIndex >= 0
        ? dayIndex
        : sched?.days?.indexOf(day);
    const previousShift =
      resolvedDayIndex != null && resolvedDayIndex >= 0
        ? row.shiftsByDay[resolvedDayIndex]
        : null;

    const key = `${line}-${year}-${monthIndex + 1}-${row.employeeId}-${day}`;
	    // Важно: в быстрых кликах используем year/monthIndex из текущего выбранного месяца,
	    // иначе state.monthMeta может быть неинициализирован/рассинхронизирован.
    const conversion = convertLocalRangeToUtcWithMeta(
      year,
      monthIndex,
      day,
      normStartLocal,
      normEndLocal
    );
	    if (!conversion) {
	      alert("Некорректное время смены. Проверьте формат (например 08:00–20:00)." );
	      return;
	    }
    state.localChanges[key] = {
      startLocal: normStartLocal,
      endLocal: normEndLocal,
      amount,
      templateId,
      specialShortLabel,
	      startUtcIso: conversion.startUtcIso,
	      endUtcIso: conversion.endUtcIso,
	      durationMinutes: conversion.durationMinutes,
    };
    persistLocalChanges();

    applyLocalChangesToSchedule();
    renderScheduleCurrentLine();
    logChange({
      action: previousShift ? "update" : "create",
      line,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      day,
      previousShift: previousShift || null,
      nextShift: {
        startLocal: normStartLocal,
        endLocal: normEndLocal,
        amount,
        specialShortLabel,
      },
    });
    return;
  }

  openShiftPopover(
    {
      line,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      day,
      shift: shift || null,
    },
    cellEl
  );
}

// -----------------------------
// Загрузка данных
// -----------------------------

async function loadInitialData() {
  try {
    const { year, monthIndex } = state.monthMeta;
    const hadCachedEmployees = loadCachedEmployees();
    const hadCachedTemplates = loadCachedShiftTemplates();
    const hadCachedSchedule = loadCachedScheduleForMonth(year, monthIndex);

    if (hadCachedTemplates) {
      initQuickAssignPanel();
    }

    if (hadCachedSchedule) {
      updateSaveButtonState();
      updateQuickModeForLine();
      if (typeof ShiftColors !== "undefined" && ShiftColors.renderColorLegend) {
        ShiftColors.renderColorLegend(state.ui.currentLine);
      }
    }

    // Все запросы стартуют одновременно, а не по очереди.
    // График и отпуска запрашиваем заранее — reloadScheduleForCurrentMonth возьмёт их из кеша.
    const monthKey = getMonthKey(year, monthIndex);
    scheduleService.loadMonthSchedule(monthKey).catch(() => {});
    vacationsService.getVacationsForMonth(monthKey).catch(() => {});
    await Promise.all([loadDepartmentsCatalog(), loadEmployees(), loadShiftsCatalog()]);
    initQuickAssignPanel();
    await reloadScheduleForCurrentMonth();
    updateSaveButtonState();
    updateQuickModeForLine();

    // Отображение легенды цветов после загрузки данных
    if (typeof ShiftColors !== 'undefined' && ShiftColors.renderColorLegend) {
      ShiftColors.renderColorLegend(state.ui.currentLine);
    }
  } catch (err) {
    console.error("loadInitialData error:", err);
  }
}

// Справочник подразделений: сопоставляем вкладки (config.lines) с item_id по названию
async function loadDepartmentsCatalog() {
  const catalogId = PYRUS_CATALOG_IDS.departments;
  if (!catalogId) return;
  const needsResolve = LINES.some((l) => l.departmentItemId == null);
  if (!needsResolve) return;
  try {
    const data = await catalogsService.getShiftsCatalog({ catalogId });
    const catalog = Array.isArray(data) ? data[0] : data;
    const headers = catalog?.catalog_headers || [];
    const items = catalog?.items || [];
    const nameColumn = PYRUS_CATALOG_COLUMNS.departments?.name;
    let idxName = headers.findIndex((h) => h.name === nameColumn);
    if (idxName < 0) idxName = 0;
    for (const line of LINES) {
      if (line.departmentItemId != null) continue;
      const wanted = line.departmentName.trim().toUpperCase();
      const item = items.find((it) => String(it.values?.[idxName] ?? "").trim().toUpperCase() === wanted);
      if (item) line.departmentItemId = item.item_id;
      else console.warn(`Подразделение "${line.departmentName}" не найдено в справочнике ${catalogId}`);
    }
  } catch (err) {
    console.error("Не удалось загрузить справочник подразделений", err);
  }
}

// Участники ролей Pyrus: roleId -> Set(memberId). Нужен для config.lines[].memberRoles.
async function loadRoleMembers() {
  const needRoles = LINES.some((l) => l.memberRoles.length > 0);
  if (!needRoles) return new Map();
  try {
    const raw = await pyrusClient.pyrusRequest("/v4/roles", { method: "GET" });
    const data = unwrapPyrusData(raw);
    const roles = (Array.isArray(data) ? data[0] : data)?.roles || [];
    return new Map(roles.map((r) => [Number(r.id), new Set((r.member_ids || []).map(Number))]));
  } catch (err) {
    console.error("Не удалось загрузить роли Pyrus", err);
    return new Map();
  }
}

async function loadEmployees() {
  const [data, roleMembers] = await Promise.all([membersService.getMembers(), loadRoleMembers()]);
  const members = membersService.extractMembersFromPyrusData(data) || [];
  const employeesByLine = makeByLine(() => []);

  for (const m of members) {
    if (m.banned) continue;
    if (m.type && m.type !== "user") continue; // боты и т.п.

    const deptId = m.department_id != null ? Number(m.department_id) : null;
    const employee = {
      id: m.id,
      fullName: `${m.last_name || ""} ${m.first_name || ""}`.trim(),
      email: m.email || "",
      departmentName: m.department_name || "",
      departmentId: deptId,
      avatarId: m.avatar_id || null,
      phone: m.phone || "",
      position: m.position || "",
      birthDay: m.birth_date && m.birth_date.day != null ? Number(m.birth_date.day) : null,
      birthMonth: m.birth_date && m.birth_date.month != null ? Number(m.birth_date.month) : null,
    };

    employeesByLine.ALL.push(employee);
    // Постоянный состав вкладки — по отделу оргструктуры Pyrus (config.lines[].orgDepartmentIds).
    // Кроме того, во вкладку попадают все, у кого есть смены этого подразделения в месяце
    // (см. reloadScheduleForCurrentMonth).
    // Постоянный состав вкладки: участники ролей (memberRoles) или отделы оргструктуры (orgDepartmentIds)
    for (const line of LINES) {
      const byRole = line.memberRoles.some((rid) => roleMembers.get(rid)?.has(Number(m.id)));
      const byDept = deptId != null && line.orgDepartmentIds.includes(deptId);
      if (byRole || byDept) employeesByLine[line.key].push(employee);
    }
  }

  const byName = (a, b) => a.fullName.localeCompare(b.fullName, "ru");
  const topIndex = new Map(TOP_MANAGEMENT_IDS.map((id, idx) => [Number(id), idx]));

  employeesByLine.ALL.sort((a, b) => {
    const at = topIndex.has(a.id) ? topIndex.get(a.id) : null;
    const bt = topIndex.has(b.id) ? topIndex.get(b.id) : null;
    if (at != null || bt != null) {
      if (at == null) return 1;
      if (bt == null) return -1;
      return at - bt;
    }
    return byName(a, b);
  });

  for (const key of ALL_LINE_KEYS) {
    state.employeesByLine[key] = key === "ALL" ? employeesByLine.ALL : employeesByLine[key].sort(byName);
  }

  persistCachedEmployees();
}

// Колонку справочника ищем по названию из config.pyrus.catalogColumns.shifts,
// иначе — по типичным названиям.
function findCatalogColumn(headers, configuredName, fallbacks) {
  const names = headers.map((h) => String(h.name || "").trim().toLowerCase());
  const candidates = [configuredName, ...fallbacks].filter(Boolean).map((n) => n.toLowerCase());
  for (const c of candidates) {
    const idx = names.indexOf(c);
    if (idx >= 0) return idx;
  }
  for (const c of candidates) {
    const idx = names.findIndex((n) => n.includes(c));
    if (idx >= 0) return idx;
  }
  return null;
}

async function loadShiftsCatalog() {
  const data = await catalogsService.getShiftsCatalog({ catalogId: PYRUS_CATALOG_IDS.shifts });

  const catalog = Array.isArray(data) ? data[0] : data;
  if (!catalog) return;

  const headers = catalog.catalog_headers || [];
  const items = catalog.items || [];
  const cols = PYRUS_CATALOG_COLUMNS.shifts || {};

  let idxName = findCatalogColumn(headers, cols.name, ["название смены", "смена", "название"]);
  if (idxName == null) idxName = 0;
  const idxTime = findCatalogColumn(headers, cols.time, ["время смены", "время"]);
  const idxAmount = findCatalogColumn(headers, cols.amount, ["сумма за смену", "сумма", "стоимость"]);
  const idxDept = findCatalogColumn(headers, cols.departments, ["подразделение", "отдел"]);

  const templatesByLine = makeByLine(() => []);

  // Колонка «Подразделение» может содержать список: "ТП, ПО" или "ВСЕ".
  // Пусто / нет колонки — смена доступна во всех вкладках.
  const parseDeptTokens = (raw) =>
    String(raw || "")
      .split(/[,/;]/)
      .map((t) => resolveLineKeyByToken(t))
      .filter(Boolean);

  for (const item of items) {
    const values = item.values || [];
    const name = values[idxName] ?? "";
    const timeRaw = idxTime != null ? values[idxTime] : "";
    const amount = idxAmount != null ? Number(values[idxAmount] || 0) : 0;
    const dept = idxDept != null ? String(values[idxDept] || "") : "";

    const timeRange = parseShiftTimeRangeString(timeRaw);
    const normalizedName = String(name || "").trim().toUpperCase();
    const specialShortLabel = ["ВЫХ", "ОТП", "ДР"].includes(normalizedName) ? normalizedName : null;

    const template = { id: item.item_id, name, timeRaw, amount, dept, timeRange, specialShortLabel };

    const tokens = parseDeptTokens(dept);
    const targets = tokens.length === 0 || tokens.includes("ALL") ? ALL_LINE_KEYS : ["ALL", ...tokens];
    for (const key of new Set(targets)) templatesByLine[key].push(template);
  }

  for (const key of ALL_LINE_KEYS) {
    state.shiftTemplatesByLine[key] = templatesByLine[key] || [];
  }

  if (typeof ShiftColors !== "undefined" && ShiftColors.initialize) {
    ShiftColors.initialize(state.shiftTemplatesByLine, state.ui.theme);
  }

  persistCachedShiftTemplates();
}

async function reloadScheduleForCurrentMonth() {
  const { year, monthIndex } = state.monthMeta;
  const monthKey = getMonthKey(year, monthIndex);
  const cachedVacations =
    typeof vacationsService.peekVacationsForMonth === "function"
      ? vacationsService.peekVacationsForMonth(monthKey)
      : null;
  if (cachedVacations) {
    state.vacationsByEmployee = cachedVacations;
  }

  // Отпуска: стартуем раньше, чтобы не ждать вместе с графиком
  let scheduleReadyForVacations = false;
  let vacationsLoaded = false;
  let vacationsData = null;
  const vacationsMonthKey = monthKey;
  const vacationsPromise = vacationsService
    .getVacationsForMonth(vacationsMonthKey)
    .then((data) => {
      if (vacationsMonthKey !== getMonthKey(state.monthMeta.year, state.monthMeta.monthIndex)) return;
      vacationsData = data || {};
      vacationsLoaded = true;
      if (scheduleReadyForVacations) {
        state.vacationsByEmployee = vacationsData;
        renderScheduleCurrentLine();
      }
    })
    .catch((e) => {
      if (vacationsMonthKey !== getMonthKey(state.monthMeta.year, state.monthMeta.monthIndex)) return;
      console.warn('Не удалось загрузить отпуска', e);
      vacationsData = {};
      vacationsLoaded = true;
      if (scheduleReadyForVacations) {
        state.vacationsByEmployee = {};
        renderScheduleCurrentLine();
      }
    });

  const scheduleResult = await scheduleService.loadMonthSchedule(monthKey);
  if (!scheduleResult.isLatest) return;

  // Производственный календарь РФ: помесячно (isdayoff.ru), с кэшем и фолбеком на СБ/ВС
  try {
    state.prodCalendar = await prodCalendarService.getProdCalendarForMonth(year, monthIndex);
  } catch (e) {
    console.warn('Не удалось загрузить производственный календарь РФ, используем фолбек СБ/ВС', e);
    state.prodCalendar = null;
  }

  if (monthKey !== getMonthKey(state.monthMeta.year, state.monthMeta.monthIndex)) {
    return;
  }

  const data = scheduleResult.data;
  const wrapper = Array.isArray(data) ? data[0] : data;
  const tasks = (wrapper && wrapper.tasks) || [];

  const scheduleByLine = makeByLine(() => ({ days: [], rows: [], monthKey: null }));
  const shiftMapByLine = makeByLine(() => Object.create(null));
  const extraEmployeeIdsByLine = makeByLine(() => new Set());

  const inferLineFromEmployee = (empId) => {
    for (const k of LINE_KEYS) {
      if ((state.employeesByLine[k] || []).some((e) => e.id === empId)) return k;
    }
    return null;
  };

  const findField = (fields, id) => fields.find((f) => f.id === id);
  const F = PYRUS_FIELD_IDS.schedule || {};

  for (const task of tasks) {
    const fields = task.fields || [];
    const dueField = findField(fields, F.due);
    const moneyField = findField(fields, F.amount);
    const personField = findField(fields, F.person);
    const shiftField = findField(fields, F.template);
    const deptField = F.department != null ? findField(fields, F.department) : null;

    if (!dueField || !personField || !shiftField) continue;

    const startUtcMs = new Date(dueField.value).getTime();
    if (Number.isNaN(startUtcMs)) continue;

    // Pyrus может не вернуть duration у поля «Дата и время смены» —
    // тогда берём длительность из шаблона смены (колонка «Время работы»).
    const shiftValueForDuration = shiftField.value || {};
    const shiftItemIdForDuration =
      shiftValueForDuration.item_id != null ? shiftValueForDuration.item_id : shiftValueForDuration.id;
    const templateForDuration =
      shiftItemIdForDuration != null
        ? (state.shiftTemplatesByLine.ALL || []).find((t) => t.id === shiftItemIdForDuration)
        : null;
    let rawDuration = Number(dueField.duration || 0);
    if (!(rawDuration > 0) && templateForDuration?.timeRange) {
      rawDuration =
        computeDurationMinutes(templateForDuration.timeRange.start, templateForDuration.timeRange.end) || 0;
    }

    const startUtcIso = new Date(startUtcMs).toISOString();
    const endUtcIso = new Date(startUtcMs + rawDuration * 60 * 1000).toISOString();

    const range = convertUtcStartToLocalRange(startUtcIso, rawDuration);
    if (!range) continue;

    const { localDateKey, startLocal, endLocal } = range;
    const [yStr, mStr, dStr] = localDateKey.split("-");
    if (Number(yStr) !== year || Number(mStr) - 1 !== monthIndex) continue;
    const d = Number(dStr);

    const empId = personField.value && personField.value.id;
    if (!empId) continue;

    const shiftCatalog = shiftField.value || {};
    const shiftItemId = shiftCatalog.item_id != null ? shiftCatalog.item_id : shiftCatalog.id;

    // Вкладка смены: поле «Подразделение» в задаче -> отдел сотрудника
    let lineKey = deptField ? resolveLineKeyByDepartmentValue(deptField.value) : null;
    if (!lineKey) lineKey = inferLineFromEmployee(empId);

    const matchingTemplate =
      shiftItemId != null ? (state.shiftTemplatesByLine.ALL || []).find((t) => t.id === shiftItemId) : null;

    const amount =
      moneyField && typeof moneyField.value === "number" ? moneyField.value : Number(moneyField?.value || 0);

    const entry = {
      startLocal,
      endLocal,
      amount,
      templateId: shiftItemId,
      taskId: task.id,
      rawDueValue: dueField.value,
      rawDuration,
      durationMinutes: rawDuration,
      startUtcIso,
      endUtcIso,
      rawShift: shiftCatalog,
      specialShortLabel: (matchingTemplate && matchingTemplate.specialShortLabel) || null,
      lineKey,
    };

    const putToMap = (key) => {
      const map = shiftMapByLine[key];
      if (!map) return;
      if (!map[empId]) map[empId] = {};
      map[empId][d] = entry;
    };

    if (lineKey) {
      putToMap(lineKey);
      extraEmployeeIdsByLine[lineKey].add(empId);
    }
    putToMap("ALL"); // "ВСЕ" всегда содержит весь график
  }

  const days = [];
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  for (let d = 1; d <= Math.min(daysInMonth, MAX_DAYS_IN_MONTH); d++) {
    days.push(d);
  }

  for (const line of ALL_LINE_KEYS) {
    // Состав вкладки: постоянный (оргструктура) + все, у кого есть смены подразделения в месяце
    const baseList = state.employeesByLine[line] || [];
    const baseIds = new Set(baseList.map((e) => e.id));
    const extra = line === "ALL"
      ? []
      : state.employeesByLine.ALL.filter((e) => extraEmployeeIdsByLine[line].has(e.id) && !baseIds.has(e.id));
    const empList = [...baseList, ...extra].sort((a, b) =>
      line === "ALL" ? 0 : a.fullName.localeCompare(b.fullName, "ru")
    );
    const map = shiftMapByLine[line];

    const rows = empList.map((emp) => {
      const shiftsByDay = days.map((d) => {
        const shift = map && map[emp.id] && map[emp.id][d];
        return shift || null;
      });
      return {
        employeeId: emp.id,
        employeeName: emp.fullName,
        birthDay: emp.birthDay ?? null,
        birthMonth: emp.birthMonth ?? null,
        shiftsByDay,
      };
    });

    scheduleByLine[line] = { monthKey, days, rows };
  }

  state.originalScheduleByLine = deepClone(scheduleByLine);
  state.scheduleByLine = scheduleByLine;
  state.ui.isScheduleCached = false;
  persistCachedScheduleForMonth(year, monthIndex);
  applyLocalChangesToSchedule();
  scheduleReadyForVacations = true;
  if (vacationsLoaded) {
    state.vacationsByEmployee = vacationsData || {};
  }
  renderScheduleCurrentLine();
}

// -----------------------------
// Рендер таблицы
// -----------------------------

function applyEmployeeFilterToTable(table, hiddenIds, emptyRowEl) {
  const tbody = table.querySelector("tbody");
  if (!tbody) return;
  const dataRows = Array.from(tbody.querySelectorAll("tr")).filter(
    (row) => !row.classList.contains("employee-filter-empty")
  );
  let visibleCount = 0;
  for (const row of dataRows) {
    const id = Number(row.dataset.employeeId);
    const shouldHide = hiddenIds.has(id);
    row.classList.toggle("employee-row-hidden", shouldHide);
    if (!shouldHide) visibleCount += 1;
  }
  if (emptyRowEl) {
    emptyRowEl.classList.toggle("hidden", visibleCount > 0);
  }
}

function renderScheduleCurrentLine() {
  closeEmployeeFilterPopover();
  const line = state.ui.currentLine;
  const sched = state.scheduleByLine[line];

  if (!sched || !sched.days || sched.days.length === 0) {
    scheduleRootEl.innerHTML =
      '<div style="padding: 12px; font-size: 13px; color: var(--text-muted);">Нет данных по графику за выбранный месяц.</div>';
    return;
  }

  const canEdit = canEditLine(line);
  const { days, rows } = sched;
  const hiddenEmployeeIds = normalizeHiddenEmployeeIds(line, rows);

  const table = document.createElement("table");
  table.className = "schedule-table";
  
  if (!canEdit) {
    table.classList.add("read-only-mode");
  }

  const thead = document.createElement("thead");
  const headRow1 = document.createElement("tr");
  const headRow2 = document.createElement("tr");

  const thName = document.createElement("th");
  thName.className = "sticky-col employee-header-cell";

  const thNameWrap = document.createElement("div");
  thNameWrap.className = "employee-header";

  const thNameLabel = document.createElement("span");
  thNameLabel.className = "header-text";
  thNameLabel.textContent = "Сотрудник";

  const filterBtn = document.createElement("button");
  filterBtn.type = "button";
  filterBtn.className = "employee-filter-btn";
  filterBtn.setAttribute("aria-label", "Фильтр сотрудников");
  filterBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7z"></path></svg>';
  if (hiddenEmployeeIds.size > 0) filterBtn.classList.add("active");

  const updateFilterButtonState = () => {
    filterBtn.classList.toggle("active", hiddenEmployeeIds.size > 0);
  };

  let emptyRow = null;

  filterBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openEmployeeFilterPopover({
      line,
      rows,
      hiddenEmployeeIds,
      table,
      emptyRow,
      onUpdateButton: updateFilterButtonState,
    });
  });

  thNameWrap.appendChild(thNameLabel);
  thNameWrap.appendChild(filterBtn);
  thName.appendChild(thNameWrap);
  headRow1.appendChild(thName);

  const thName2 = document.createElement("th");
  thName2.className = "sticky-col";
  thName2.textContent = "";
  headRow2.appendChild(thName2);

  const weekdayNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const { year, monthIndex } = state.monthMeta;
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const dayKindByDay = Object.create(null);

  const prod = state.prodCalendar && state.prodCalendar.monthKey === monthKey ? state.prodCalendar : null;

  for (const day of days) {
    const date = new Date(year, monthIndex, day);
    const weekday = weekdayNames[(date.getDay() + 6) % 7];

    const dayType = prod && prod.dayTypeByDay ? prod.dayTypeByDay[day] : null;
    // Фолбек, если производственного календаря нет: СБ/ВС и фиксированные праздники РФ
    const isFallbackHoliday = (FIXED_RU_HOLIDAYS[monthIndex + 1] || []).includes(day);
    const isFallbackWeekend = weekday === "Сб" || weekday === "Вс";

    const dayKind = dayType === 1
      ? "weekend"
      : dayType === 8
        ? "holiday"
        : dayType === 2
          ? "preholiday"
          : dayType === 0 || dayType === 4
            ? "workday"
            : dayType == null
              ? (isFallbackHoliday ? "holiday" : isFallbackWeekend ? "weekend" : "workday")
              : null;

    const th1 = document.createElement("th");
const th1Label = document.createElement("span");
th1Label.className = "header-text";
th1Label.textContent = String(day);
th1.appendChild(th1Label);

    if (dayKind) {
      th1.classList.add(`day-${dayKind}`);
      dayKindByDay[day] = dayKind;
      const kindLabel = { weekend: "Выходной", holiday: "Праздник", preholiday: "Сокращённый (предпраздничный) день" }[dayKind];
      if (kindLabel) th1.title = kindLabel;
    }
    headRow1.appendChild(th1);

    const th2 = document.createElement("th");
    const th2Label = document.createElement("span");
    th2Label.className = "header-text";
    th2Label.textContent = weekday;
    th2.appendChild(th2Label);
    th2.className = "weekday-header";
    if (dayKind) {
      th2.classList.add(`day-${dayKind}`);
    }
    headRow2.appendChild(th2);
  }

  const thCount1 = document.createElement("th");
  const thCount1Label = document.createElement("span");
  thCount1Label.className = "header-text";
  thCount1Label.textContent = "кол-во";
  thCount1.appendChild(thCount1Label);
  thCount1.className = "summary-cell";
  headRow1.appendChild(thCount1);

  const thCount2 = document.createElement("th");
  thCount2.textContent = "";
  thCount2.className = "summary-cell";
  headRow2.appendChild(thCount2);

  const thSum1 = document.createElement("th");
  const thSum1Label = document.createElement("span");
  thSum1Label.className = "header-text";
  thSum1Label.textContent = "Сумма";
  thSum1.appendChild(thSum1Label);
  thSum1.className = "summary-cell";
  headRow1.appendChild(thSum1);

  const thSum2 = document.createElement("th");
  thSum2.textContent = "";
  thSum2.className = "summary-cell";
  headRow2.appendChild(thSum2);

  thead.appendChild(headRow1);
  thead.appendChild(headRow2);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.dataset.employeeId = String(row.employeeId);

    const tdName = document.createElement("td");
    tdName.className = "sticky-col employee-name";
    tdName.textContent = row.employeeName;
    tr.appendChild(tdName);

    let totalAmount = 0;
    let totalShifts = 0;

    const vacations = state.vacationsByEmployee[row.employeeId] || [];
    const vacationStarts = Object.create(null);
    for (const v of vacations) {
      if (v && typeof v.startDay === "number") {
        vacationStarts[v.startDay] = v;
      }
    }

    // День рождения (ежегодно): показываем в текущем месяце, если есть day/month.
    const birthdayDayThisMonth =
      row.birthMonth && row.birthDay && row.birthMonth === monthIndex + 1
        ? row.birthDay
        : null;

    let dayIndex = 0;
    while (dayIndex < row.shiftsByDay.length) {
      const dayNumber = sched.days[dayIndex];
      const vac = vacationStarts[dayNumber];

      if (vac) {
        const len = Math.max(1, (vac.endDayExclusive || (vac.startDay + 1)) - vac.startDay);

        const td = document.createElement("td");
        td.className = "shift-cell vacation-cell";
        td.colSpan = len;

        const pill = document.createElement("div");
        pill.className = "vacation-pill";
        // Текст внутри полосы (оставляем как метку, но не мешаем бейджам поверх)
        const vacLabel = document.createElement("span");
        vacLabel.className = "vacation-label";
        vacLabel.textContent = "ОТП";
        pill.title = `Отпуск: с ${vac.startLabel} по ${vac.endLabel}`;

        pill.appendChild(vacLabel);

        // Если день рождения попадает внутрь отпуска (в текущем месяце) —
        // показываем маркер "ДР" поверх отпускной полосы.
        if (
          typeof birthdayDayThisMonth === "number" &&
          birthdayDayThisMonth >= vac.startDay &&
          birthdayDayThisMonth < (vac.endDayExclusive || vac.startDay + 1)
        ) {
          const b = document.createElement("div");
          b.className = "birthday-pill birthday-pill-in-vacation";
          b.textContent = "ДР";
          const leftPercent = ((birthdayDayThisMonth - vac.startDay) + 0.5) / len * 100;
          b.style.left = `${leftPercent}%`;
          b.title = `День рождения: ${formatBirthdayLabel(birthdayDayThisMonth, monthIndex + 1)}`;
          b.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openBirthdayPopover(
              {
                employeeName: row.employeeName,
                dateLabel: formatBirthdayLabel(birthdayDayThisMonth, monthIndex + 1),
              },
              b
            );
          });
          pill.appendChild(b);
        }

        td.appendChild(pill);

        td.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openVacationPopover(
            {
              employeeName: row.employeeName,
              startLabel: vac.startLabel,
              endLabel: vac.endLabel,
            },
            td
          );
        });

        td.addEventListener("mouseenter", () => {
          tr.classList.add("row-hover");
        });
        td.addEventListener("mouseleave", () => {
          tr.classList.remove("row-hover");
        });

        tr.appendChild(td);
        dayIndex += len;
        continue;
      }

      const shift = row.shiftsByDay[dayIndex];

      const td = document.createElement("td");
      td.className = "shift-cell";
      const dayKind = dayKindByDay[dayNumber];
      if (dayKind) {
        td.classList.add(`day-${dayKind}`);
      }

      // Маркер дня рождения (один день). Показываем даже если в этот день есть смена.
      if (typeof birthdayDayThisMonth === "number" && birthdayDayThisMonth === dayNumber) {
        const b = document.createElement("div");
        b.className = "birthday-pill";
        b.textContent = "ДР";
        b.title = `День рождения: ${formatBirthdayLabel(dayNumber, monthIndex + 1)}`;
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openBirthdayPopover(
            {
              employeeName: row.employeeName,
              dateLabel: formatBirthdayLabel(dayNumber, monthIndex + 1),
            },
            b
          );
        });
        td.appendChild(b);
      }

      if (shift) {
        td.classList.add("has-shift");
        const pill = document.createElement("div");
        pill.className = "shift-pill";

        // Применение цвета к pill
        if (typeof ShiftColors !== 'undefined' && ShiftColors.applyColorToPill && shift.templateId) {
          ShiftColors.applyColorToPill(pill, shift.templateId, line);
        }

        if (shift.specialShortLabel) {
          pill.classList.add("special");
          const label = document.createElement("div");
          label.className = "shift-special-label";
          label.textContent = shift.specialShortLabel;
          pill.appendChild(label);
        } else {
          const line1 = document.createElement("div");
          line1.className = "shift-time-line start";
          line1.textContent = shift.startLocal;

          const line2 = document.createElement("div");
          line2.className = "shift-time-line end";
          line2.textContent = shift.endLocal;

          pill.appendChild(line1);
          pill.appendChild(line2);
        }
        td.appendChild(pill);

        totalAmount += shift.amount || 0;
        totalShifts += 1;
      } else {
        td.classList.add("empty-shift");
      }

      const clickDay = dayNumber;
      const clickDayIndex = dayIndex;
      td.addEventListener("click", () => {
        handleShiftCellClick({
          line,
          row,
          day: clickDay,
          dayIndex: clickDayIndex,
          shift: shift || null,
          cellEl: td,
        });
      });

      td.addEventListener("mouseenter", () => {
        tr.classList.add("row-hover");
      });
      td.addEventListener("mouseleave", () => {
        tr.classList.remove("row-hover");
      });

      tr.appendChild(td);
      dayIndex += 1;
    }


    const tdCount = document.createElement("td");
    tdCount.className = "summary-cell";
    tdCount.textContent = totalShifts > 0 ? String(totalShifts) : "";
    tr.appendChild(tdCount);

    const tdSum = document.createElement("td");
    tdSum.className = "summary-cell";
    tdSum.textContent =
      totalAmount > 0 ? `${totalAmount.toLocaleString("ru-RU")} ₽` : "";
    tr.appendChild(tdSum);

    tbody.appendChild(tr);
  });

  emptyRow = document.createElement("tr");
  emptyRow.className = "employee-filter-empty hidden";
  const emptyCell = document.createElement("td");
  emptyCell.colSpan = days.length + 3;
  emptyCell.textContent = "Нет сотрудников для отображения по фильтру.";
  emptyRow.appendChild(emptyCell);
  tbody.appendChild(emptyRow);

  table.appendChild(tbody);
  scheduleRootEl.innerHTML = "";
  scheduleRootEl.appendChild(table);
  updateFilterButtonState();
  applyEmployeeFilterToTable(table, hiddenEmployeeIds, emptyRow);
}

// -----------------------------
// Поповер смены
// -----------------------------

function createShiftPopover() {
  shiftPopoverBackdropEl = document.createElement("div");
  shiftPopoverBackdropEl.className = "shift-popover-backdrop hidden";

  shiftPopoverEl = document.createElement("div");
  shiftPopoverEl.className = "shift-popover hidden";

  shiftPopoverBackdropEl.addEventListener("click", () => {
    closeShiftPopover();
  });

  document.body.appendChild(shiftPopoverBackdropEl);
  document.body.appendChild(shiftPopoverEl);
}

function resolveTemplateName(line, templateId) {
  if (!line || templateId == null) return null;
  const templates = state.shiftTemplatesByLine[line] || [];
  const template = templates.find((tmpl) => tmpl.id === templateId);
  return template ? template.name : null;
}

function resolveShiftDisplayName(line, templateId, specialShortLabel) {
  const templateName = resolveTemplateName(line, templateId);
  if (templateName) return templateName;
  if (specialShortLabel) return specialShortLabel;
  if (templateId != null) return `Шаблон #${templateId}`;
  return "Ручная смена";
}

function updateShiftPopoverName(line, templateId, specialShortLabel, showManual = false) {
  const nameEl = shiftPopoverEl?.querySelector("#shift-popover-shift-name");
  if (!nameEl) return;
  if (templateId == null && !specialShortLabel && !showManual) {
    nameEl.textContent = "";
    return;
  }
  nameEl.textContent = resolveShiftDisplayName(line, templateId, specialShortLabel);
}

function positionShiftPopover(anchorEl) {
  if (!shiftPopoverEl || !anchorEl) return;

  const rect = anchorEl.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  shiftPopoverEl.style.left = "0px";
  shiftPopoverEl.style.top = "0px";

  const popoverRect = shiftPopoverEl.getBoundingClientRect();
  const popoverWidth = popoverRect.width || 420;
  const popoverHeight = popoverRect.height || 260;

  let left = rect.left + 8;
  let top = rect.bottom + 8;

  if (left + popoverWidth > viewportWidth - 16) {
    left = viewportWidth - popoverWidth - 16;
  }

  const fitsBelow = top + popoverHeight <= viewportHeight - 16;
  const fitsAbove = rect.top - popoverHeight - 8 >= 16;

  if (!fitsBelow && fitsAbove) {
    top = rect.top - popoverHeight - 8;
  }

  left = Math.max(16, Math.min(left, viewportWidth - popoverWidth - 16));
  top = Math.max(16, Math.min(top, viewportHeight - popoverHeight - 16));

  shiftPopoverEl.style.left = `${left}px`;
  shiftPopoverEl.style.top = `${top}px`;
}

function closeShiftPopover() {
  if (!shiftPopoverEl) return;

  shiftPopoverEl.classList.remove("open");
  shiftPopoverBackdropEl.classList.add("hidden");

  if (shiftPopoverKeydownHandler) {
    document.removeEventListener("keydown", shiftPopoverKeydownHandler);
    shiftPopoverKeydownHandler = null;
  }

  setTimeout(() => {
    shiftPopoverEl.classList.add("hidden");
    shiftPopoverEl.innerHTML = "";
  }, 140);
}

function formatBirthdayLabel(day, month) {
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${dd}.${mm}`;
}

function openBirthdayPopover(context, anchorEl) {
  const { employeeName, dateLabel } = context;

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">День рождения • только просмотр</div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Дата</div>
        <div class="field-row"><label>день:</label><div>${dateLabel}</div></div>
      </div>
      <div class="shift-popover-note">Данные дня рождения загружаются из списка сотрудников и не редактируются здесь.</div>
    </div>

    <div class="shift-popover-footer">
      <button class="btn" type="button" id="shift-btn-close-birthday">Закрыть</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");
  positionShiftPopover(anchorEl);

  const closeBtn = shiftPopoverEl.querySelector(".shift-popover-close");
  const closeBtn2 = shiftPopoverEl.querySelector("#shift-btn-close-birthday");
  const doClose = () => closeShiftPopover();
  if (closeBtn) closeBtn.addEventListener("click", doClose);
  if (closeBtn2) closeBtn2.addEventListener("click", doClose);

  shiftPopoverKeydownHandler = (ev) => {
    if (ev.key === "Escape") doClose();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });
}



function openVacationPopover(context, anchorEl) {
  const { employeeName, startLabel, endLabel } = context;

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">Отпуск • только просмотр</div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Период</div>
        <div class="field-row"><label>с:</label><div>${startLabel}</div></div>
        <div class="field-row"><label>по:</label><div>${endLabel}</div></div>
      </div>
      <div class="shift-popover-note">Отпуск загружается из внешней системы и не редактируется здесь.</div>
    </div>

    <div class="shift-popover-footer">
      <button class="btn" type="button" id="shift-btn-close-vacation">Закрыть</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");
  positionShiftPopover(anchorEl);

  const closeBtn = shiftPopoverEl.querySelector(".shift-popover-close");
  const closeBtn2 = shiftPopoverEl.querySelector("#shift-btn-close-vacation");

  const doClose = () => closeShiftPopover();
  if (closeBtn) closeBtn.addEventListener("click", doClose);
  if (closeBtn2) closeBtn2.addEventListener("click", doClose);

  shiftPopoverKeydownHandler = (ev) => {
    if (ev.key === "Escape") doClose();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });
}
function openShiftPopoverReadOnly(context, anchorEl) {
  const { line, employeeName, day, shift } = context;
  const { year, monthIndex } = state.monthMeta;
  
  const dateLabel = `${String(day).padStart(2, "0")}.${String(
    monthIndex + 1
  ).padStart(2, "0")}.${year}`;

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">${dateLabel} • ${LINE_LABELS[line] || line} (только просмотр)</div>
        <div class="shift-popover-shift-name" id="shift-popover-shift-name"></div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      ${shift ? `
        <div class="shift-popover-section">
          <div class="shift-popover-section-title">Информация о смене</div>
          
          <div class="field-row">
            <label>Начало:</label>
            <div>${shift.startLocal || "—"}</div>
          </div>

          <div class="field-row">
            <label>Окончание:</label>
            <div>${shift.endLocal || "—"}</div>
          </div>

          <div class="field-row">
            <label>Сумма:</label>
            <div>${shift.amount ? shift.amount.toLocaleString('ru-RU') + ' ₽' : "—"}</div>
          </div>
        </div>
      ` : `
        <div class="shift-popover-note">
          Смена не назначена. У вас нет прав на редактирование.
        </div>
      `}
    </div>

    <div class="shift-popover-footer">
      <button class="btn" type="button" id="shift-btn-close-readonly">Закрыть</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");
  updateShiftPopoverName(
    line,
    shift?.templateId ?? null,
    shift?.specialShortLabel,
    Boolean(shift)
  );
  positionShiftPopover(anchorEl);

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });

  shiftPopoverEl
    .querySelector(".shift-popover-close")
    .addEventListener("click", closeShiftPopover);
  shiftPopoverEl
    .querySelector("#shift-btn-close-readonly")
    .addEventListener("click", closeShiftPopover);

  shiftPopoverKeydownHandler = (e) => {
    if (e.key === "Escape") closeShiftPopover();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);
}

function openShiftPopover(context, anchorEl) {
  const { line, employeeId, employeeName, day, shift } = context;
  const { year, monthIndex } = state.monthMeta;
  const date = new Date(year, monthIndex, day);
  const hasShift = Boolean(shift);
  let selectedTemplateId = shift?.templateId ?? null;

  const dateLabel = `${String(day).padStart(2, "0")}.${String(
    monthIndex + 1
  ).padStart(2, "0")}.${year}`;

  const templates = state.shiftTemplatesByLine[line] || [];

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">${dateLabel} • ${LINE_LABELS[line] || line}</div>
        <div class="shift-popover-shift-name" id="shift-popover-shift-name"></div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Шаблоны смен</div>
        <div class="shift-template-list">
          ${templates
            .map(
              (t) => `
            <button class="shift-template-pill" data-template-id="${t.id}">
              <div class="name">${t.name}</div>
              ${
                t.timeRange
                  ? `<div class="time">${t.timeRange.start}–${t.timeRange.end}</div>`
                  : ""
              }
            </button>
          `
            )
            .join("")}
        </div>
      </div>

      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Ручное редактирование</div>

        <div class="field-row">
          <label>Начало</label>
          <input type="time" id="shift-start-input" value="${
            shift?.startLocal || ""
          }">
        </div>

        <div class="field-row">
          <label>Окончание</label>
          <input type="time" id="shift-end-input" value="${
            shift?.endLocal || ""
          }">
        </div>

        <div class="field-row">
          <label>Сумма</label>
          <input type="number" id="shift-amount-input" value="${
            shift?.amount || ""
          }">
        </div>

        <div class="shift-popover-note">
          Изменения сохраняются в локальном кэше в браузере и не отправляются в Pyrus.
        </div>
      </div>
    </div>

    <div class="shift-popover-footer">
      <button class="btn danger" type="button" id="shift-btn-delete" ${
        hasShift ? "" : "disabled"
      }>Удалить</button>
      <button class="btn" type="button" id="shift-btn-cancel">Отмена</button>
      <button class="btn primary" type="button" id="shift-btn-save">Сохранить локально</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");
  updateShiftPopoverName(
    line,
    selectedTemplateId ?? shift?.templateId,
    shift?.specialShortLabel,
    hasShift
  );
  positionShiftPopover(anchorEl);

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });

  shiftPopoverEl
    .querySelector(".shift-popover-close")
    .addEventListener("click", closeShiftPopover);
  shiftPopoverEl
    .querySelector("#shift-btn-cancel")
    .addEventListener("click", closeShiftPopover);

  const deleteBtn = shiftPopoverEl.querySelector("#shift-btn-delete");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      const key = `${line}-${year}-${monthIndex + 1}-${employeeId}-${day}`;
      state.localChanges[key] = { deleted: true };
      persistLocalChanges();

      applyLocalChangesToSchedule();
      renderScheduleCurrentLine();
      logChange({
        action: "delete",
        line,
        employeeId,
        employeeName,
        day,
        previousShift: shift || null,
        nextShift: null,
      });
      closeShiftPopover();
    });
  }

  shiftPopoverEl
    .querySelectorAll(".shift-template-pill")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-template-id"));
        const tmpl = templates.find((t) => t.id === id);
        if (!tmpl) return;

        selectedTemplateId = id;
        updateShiftPopoverName(line, id, tmpl.specialShortLabel);

        if (tmpl.timeRange) {
          const startInput = document.getElementById("shift-start-input");
          const endInput = document.getElementById("shift-end-input");
          if (startInput && endInput) {
	        startInput.value = normalizeTimeHHMM(tmpl.timeRange.start);
	        endInput.value = normalizeTimeHHMM(tmpl.timeRange.end);
          }
        }

        const amountInput = document.getElementById("shift-amount-input");
        if (amountInput && tmpl.amount) {
          amountInput.value = tmpl.amount;
        }
      });
    });

  shiftPopoverEl
    .querySelector("#shift-btn-save")
    .addEventListener("click", () => {
      const startInput = document.getElementById("shift-start-input");
      const endInput = document.getElementById("shift-end-input");
      const amountInput = document.getElementById("shift-amount-input");

	    const start = normalizeTimeHHMM(startInput.value);
	    const end = normalizeTimeHHMM(endInput.value);
      const amount = Number(amountInput.value || 0);

      const key = `${line}-${year}-${monthIndex + 1}-${employeeId}-${day}`;
      const templateId =
        selectedTemplateId != null ? selectedTemplateId : shift?.templateId;
      const specialShortLabel = resolveSpecialShortLabel(line, templateId);
	      // В поповере всегда есть year/monthIndex выбранного месяца — используем их,
	      // чтобы не ловить RangeError на невалидном state.monthMeta.
	      const conversion = convertLocalRangeToUtcWithMeta(year, monthIndex, day, start, end);
	      if (!conversion) {
	        alert("Некорректное время смены. Проверьте формат (например 08:00–20:00)." );
	        return;
	      }
      state.localChanges[key] = {
        startLocal: start,
        endLocal: end,
        amount,
        templateId,
        specialShortLabel,
	        startUtcIso: conversion.startUtcIso,
	        endUtcIso: conversion.endUtcIso,
	        durationMinutes: conversion.durationMinutes,
      };
      persistLocalChanges();

      applyLocalChangesToSchedule();
      renderScheduleCurrentLine();
      logChange({
        action: shift ? "update" : "create",
        line,
        employeeId,
        employeeName,
        day,
        previousShift: shift || null,
        nextShift: { startLocal: start, endLocal: end, amount, specialShortLabel },
      });
      closeShiftPopover();
    });

  shiftPopoverKeydownHandler = (e) => {
    if (e.key === "Escape") closeShiftPopover();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);
}

function applyLocalChangesToSchedule() {
  for (const line of ALL_LINE_KEYS) {
    const sched = state.scheduleByLine[line];
    if (!sched || !sched.rows) continue;

    const { year, monthIndex } = state.monthMeta;

    for (const row of sched.rows) {
      sched.days.forEach((day, idx) => {
        const key = `${line}-${year}-${
          monthIndex + 1
        }-${row.employeeId}-${day}`;
        const change = state.localChanges[key];
        if (!change || typeof change !== "object") return;

        if (change.deleted) {
          row.shiftsByDay[idx] = null;
          return;
        }

        const enriched = change.startUtcIso
          ? change
          : convertLocalRangeToUtc(day, change.startLocal, change.endLocal) ||
            change;

        const specialShortLabel =
          change.specialShortLabel ??
          resolveSpecialShortLabel(line, change.templateId ?? row.shiftsByDay[idx]?.templateId);

        if (!row.shiftsByDay[idx]) {
          row.shiftsByDay[idx] = {
            startLocal: change.startLocal,
            endLocal: change.endLocal,
            amount: Number(change.amount || 0),
            templateId: change.templateId ?? null,
            specialShortLabel,
            startUtcIso: enriched.startUtcIso || null,
            endUtcIso: enriched.endUtcIso || null,
            durationMinutes: enriched.durationMinutes ?? null,
          };
        } else {
          row.shiftsByDay[idx].startLocal = change.startLocal;
          row.shiftsByDay[idx].endLocal = change.endLocal;
          row.shiftsByDay[idx].amount = Number(change.amount || 0);
          if (change.templateId != null) {
            row.shiftsByDay[idx].templateId = change.templateId;
          }
          row.shiftsByDay[idx].specialShortLabel = specialShortLabel;
          row.shiftsByDay[idx].startUtcIso = enriched.startUtcIso || null;
          row.shiftsByDay[idx].endUtcIso = enriched.endUtcIso || null;
          row.shiftsByDay[idx].durationMinutes =
            enriched.durationMinutes ?? row.shiftsByDay[idx].durationMinutes;
        }
      });
    }
  }
}

const start = async () => {
  try {
    await init();
  } catch (err) {
    console.error("Init error:", err);
  } finally {
    document.body?.classList.remove("booting");
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);

  // Gradient hover animation handled in CSS.
} else {
  start();
}
