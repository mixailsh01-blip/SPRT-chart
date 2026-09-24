// js/config.js
//
// Единственный источник настроек — config.json.
// Здесь нет ID конкретной компании: только нейтральные дефолты структуры.

const DEFAULT_CONFIG = {
  api: {
    // Один endpoint бэкенда. Сейчас — webhook n8n, потом — сервис в Docker.
    baseUrl: "",
    timeoutMs: 30000,
  },
  auth: {
    // Провайдер входа реализуется на бэкенде (auth.start / auth.verify).
    provider: "mango",
    identifier: {
      type: "phone", // phone | email
      label: "Телефон",
      placeholder: "+7 900 000-00-00",
    },
    codeLength: 6,
    resendTimerSec: 60,
    texts: {
      hint: "Отправим код подтверждения.",
      sendLabel: "Получить код",
      sentTo: "Код отправлен на",
      verifyLabel: "Подтвердить",
      resendLabel: "Повторная отправка",
      changeLabel: "Изменить",
    },
    // Права для UI. Настоящая проверка прав — на бэкенде.
    permissions: {
      editAll: [], // role id Pyrus: редактируют все подразделения
      viewDefault: "all", // all — все авторизованные видят график
    },
  },
  lines: [
    // { key, label, departmentName, departmentItemId, orgDepartmentIds: [], memberRoles: [], editRoles: [] }
  ],
  pyrus: {
    catalogs: { shifts: null, departments: null },
    catalogColumns: {
      shifts: { name: "", time: "", amount: "", departments: "" },
      departments: { name: "" },
    },
    forms: { schedule: null, vacations: null },
    fields: {
      schedule: { department: null, person: null, due: null, amount: null, template: null },
      vacations: { period: null, year: null, person: null, department: null, days: null },
    },
  },
  management: { topManagementIds: [] },
  timezone: { localOffsetMin: 4 * 60 },
  storage: {
    keys: {
      localChanges: "sprt_local_changes",
      changeHistory: "sprt_change_history",
      theme: "sprt_theme_preference",
      currentLine: "sprt_current_line",
      employeeFilters: "sprt_employee_filters",
      cachedEmployees: "sprt_cached_employees",
      cachedShiftTemplates: "sprt_cached_shift_templates",
      cachedSchedulePrefix: "sprt_cached_schedule_",
      shiftDrafts: "sprt_shift_drafts_v1",
    },
    auth: {
      key: "sprt_auth_v1",
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      cookieDays: 7,
    },
  },
  calendar: {
    prodCal: {
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      urlTemplate:
        "https://isdayoff.ru/api/getdata?year={year}&month={month}&day1=1&day2={lastDay}&pre=1&holiday=1",
      cacheKeyPrefix: "prodcal_ru_",
    },
    ui: {
      light: {
        workday: { background: "transparent", border: "var(--table-border-strong)", dash: "transparent" },
        // Выходной — приглушённый серый, праздник — красный, сокращённый день — жёлтый
        weekend: { background: "#E3EAEE", border: "var(--table-border-strong)", dash: "transparent" },
        holiday: { background: "#F9CDD2", border: "#E02B3D", dash: "transparent" },
        preholiday: { background: "#FFF1C2", border: "var(--table-border-strong)", dash: "#D9A915" },
        microIndicators: { weekend: "#9FB3BF", holiday: "#E02B3D", preholiday: "#D9A915" },
      },
      dark: {
        workday: { background: "transparent", border: "var(--table-border-strong)", dash: "transparent" },
        weekend: { background: "rgba(1, 16, 24, 0.45)", border: "var(--table-border-strong)", dash: "transparent" },
        holiday: { background: "rgba(224, 43, 61, 0.32)", border: "#E02B3D", dash: "transparent" },
        preholiday: { background: "rgba(230, 190, 60, 0.12)", border: "var(--table-border-strong)", dash: "#E6BE3C" },
        microIndicators: { weekend: "#5E7F90", holiday: "#E02B3D", preholiday: "#E6BE3C" },
      },
    },
    indicators: { birthdayBg: "#E02B3D", birthdayText: "#FFFFFF" },
  },
};

const REQUIRED_PATHS = [
  "api.baseUrl",
  "lines",
  "pyrus.catalogs.shifts",
  "pyrus.forms.schedule",
  "pyrus.fields.schedule.person",
  "pyrus.fields.schedule.due",
  "pyrus.fields.schedule.template",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Глубокое слияние: объекты сливаются, массивы и примитивы из override заменяют дефолт.
function deepMerge(base, override) {
  if (!isPlainObject(base)) return override === undefined ? base : override;
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return result;
}

function normalizeLines(rawLines) {
  if (!Array.isArray(rawLines)) return [];
  return rawLines
    .filter((l) => l && l.key)
    .map((l) => ({
      key: String(l.key),
      label: String(l.label ?? l.key),
      departmentName: String(l.departmentName ?? l.label ?? l.key),
      departmentItemId: l.departmentItemId ?? null,
      orgDepartmentIds: Array.isArray(l.orgDepartmentIds) ? l.orgDepartmentIds.map(Number) : [],
      editRoles: Array.isArray(l.editRoles) ? l.editRoles.map(String) : [],
      memberRoles: Array.isArray(l.memberRoles) ? l.memberRoles.map(Number) : [],
    }));
}

function normalizeConfig(loaded) {
  const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(loaded) ? loaded : {});
  merged.lines = normalizeLines(merged.lines);
  return merged;
}

function resolvePath(obj, path) {
  if (!path) return undefined;
  let current = obj;
  for (const part of String(path).split(".").filter(Boolean)) {
    if (current && Object.prototype.hasOwnProperty.call(current, part)) current = current[part];
    else return undefined;
  }
  return current;
}

function warnMissingRequiredPaths(cfg) {
  const missing = REQUIRED_PATHS.filter((p) => {
    const v = resolvePath(cfg, p);
    return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) console.error(`config.json: не заполнены ключи: ${missing.join(", ")}`);
}

const CONFIG_URL = new URL("../config.json", import.meta.url).toString();

async function loadConfig() {
  let loaded = {};
  try {
    // index.html начинает загрузку config.json заранее (window.__configPromise)
    const early = window.__configPromise;
    window.__configPromise = null;
    loaded = early ? await early.catch(() => null) : null;
    if (!loaded) {
      const response = await fetch(CONFIG_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      loaded = await response.json();
    }
  } catch (error) {
    console.error("Не удалось загрузить config.json", error);
  }
  const normalized = normalizeConfig(loaded);
  warnMissingRequiredPaths(normalized);
  window.APP_CONFIG = normalized; // только для отладки
  return normalized;
}

export const config = await loadConfig();

export function getConfigValue(path, options = {}) {
  const { defaultValue = undefined, required = false } = options;
  const value = resolvePath(config, path);
  if (value === undefined || value === null) {
    if (required) console.error(`Отсутствует ключ конфига: ${path}`);
    return defaultValue;
  }
  return value;
}

export function getConfig() {
  return config;
}
