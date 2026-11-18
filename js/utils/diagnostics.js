const KEY = "sprt_diagnostics_v1";
const LIMIT = 250;
let entries = [];
try {
  const stored = JSON.parse(sessionStorage.getItem(KEY) || "[]");
  if (Array.isArray(stored)) entries = stored.slice(-LIMIT).filter(row =>
    row && typeof row.at === "string" && typeof row.event === "string");
} catch {}

export function recordDiagnostic(event, details = {}) {
  const safe = { at: new Date().toISOString(), event };
  for (const key of ["action", "path", "status", "code", "durationMs", "attempt", "online", "month", "cached"]) {
    const value = details[key];
    if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
    else if (typeof value === "string" && /^[a-zA-Z0-9_./:-]{1,100}$/.test(value)) safe[key] = value;
  }
  entries.push(safe);
  entries = entries.slice(-LIMIT);
  try { sessionStorage.setItem(KEY, JSON.stringify(entries)); } catch {}
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => recordDiagnostic("network.online", { online: true }));
  window.addEventListener("offline", () => recordDiagnostic("network.offline", { online: false }));
  recordDiagnostic("page.start", { online: navigator.onLine });
}

export function downloadDiagnostics(state = {}) {
  const connection = navigator.connection;
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    origin: location.origin,
    browser: navigator.userAgent,
    online: navigator.onLine,
    connection: connection ? {
      effectiveType: connection.effectiveType, rtt: connection.rtt, downlink: connection.downlink,
    } : null,
    state,
    entries: entries.slice(),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "sprt-diagnostics-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
