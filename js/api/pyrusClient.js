export function unwrapPyrusData(raw) {
  if (typeof raw === "string") {
    try {
      return unwrapPyrusData(JSON.parse(raw));
    } catch (_) {
      return raw;
    }
  }
  if (Array.isArray(raw) && raw.length === 1 && raw[0] && typeof raw[0] === "object") {
    const only = raw[0];
    if (typeof only.json === "string") {
      try {
        return unwrapPyrusData(JSON.parse(only.json));
      } catch (_) {}
    }
  }
  if (raw && typeof raw === "object" && typeof raw.json === "string") {
    try {
      return unwrapPyrusData(JSON.parse(raw.json));
    } catch (_) {}
  }
  if (
    raw &&
    typeof raw === "object" &&
    Object.prototype.hasOwnProperty.call(raw, "data") &&
    Object.prototype.hasOwnProperty.call(raw, "success")
  ) {
    return raw.data;
  }
  return raw;
}

export function createPyrusClient({ apiClient }) {
  if (!apiClient || typeof apiClient.call !== "function") {
    throw new Error("apiClient is required for pyrusClient");
  }

  // Прокси к Pyrus API через бэкенд (action "pyrus.request").
  // Бэкенд обязан пропускать только пути из белого списка (см. docs/API_CONTRACT.md).
  async function pyrusRequest(endpoint, payload = {}) {
    const method = payload.method || "GET";
    const body = payload.body || null;
    const requestPayload = { path: endpoint, method };
    if (body) requestPayload.body = body;
    return apiClient.call("pyrus.request", requestPayload);
  }

  return { pyrusRequest };
}
