import { recordDiagnostic } from "../utils/diagnostics.js";

export function listenForScheduleChanges({ apiUrl, getToken, onChange, onUnauthorized }) {
  const url = new URL(apiUrl.replace(/\/+$/, "") + "/events", window.location.href);
  if (url.origin !== window.location.origin) return () => {};

  const controller = new AbortController();
  const { signal } = controller;
  let currentRequest;
  const reconnect = () => currentRequest?.abort();
  window.addEventListener("online", reconnect);

  async function listen() {
    let retryMs = 1000;
    while (!signal.aborted) {
      const token = getToken();
      if (!token) return;
      const requestController = new AbortController();
      currentRequest = requestController;
      let watchdog = setTimeout(() => requestController.abort(), 45_000);
      recordDiagnostic("events.connect", { online: navigator.onLine });
      try {
        const response = await fetch(url, {
          headers: { Authorization: "Bearer " + token, Accept: "text/event-stream" },
          credentials: "omit",
          signal: AbortSignal.any([signal, requestController.signal]),
        });
        recordDiagnostic("events.response", { status: response.status });
        if (response.status === 401) {
          if (!signal.aborted && token === getToken()) onUnauthorized();
          return;
        }
        if (response.status === 404 || response.status === 405) return;
        if (!response.ok) throw new Error("HTTP " + response.status);
        retryMs = 1000;

        if (!response.body) throw new Error("Поток событий недоступен");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(watchdog);
          watchdog = setTimeout(() => requestController.abort(), 45_000);
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!signal.aborted && event.startsWith("event: schedule\n")) onChange();
          }
        }
      } catch {
        if (signal.aborted) return;
        recordDiagnostic("events.disconnected", {
          code: requestController.signal.aborted ? "TIMEOUT_OR_NETWORK_CHANGE" : "NETWORK_ERROR",
          online: navigator.onLine,
        });
      } finally {
        clearTimeout(watchdog);
        currentRequest = null;
        requestController.abort();
      }
      if (signal.aborted) return;
      await new Promise(resolve => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 15_000);
    }
  }

  listen();
  return () => {
    window.removeEventListener("online", reconnect);
    controller.abort();
  };
}
