export function listenForScheduleChanges({ apiUrl, getToken, onChange, onUnauthorized }) {
  const url = new URL(apiUrl.replace(/\/+$/, "") + "/events", window.location.href);
  if (url.origin !== window.location.origin) return () => {};

  const controller = new AbortController();
  const { signal } = controller;

  async function listen() {
    let retryMs = 1000;
    while (!signal.aborted) {
      const token = getToken();
      if (!token) return;
      try {
        const response = await fetch(url, {
          headers: { Authorization: "Bearer " + token, Accept: "text/event-stream" },
          credentials: "omit",
          signal,
        });
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
      }
      if (signal.aborted) return;
      await new Promise(resolve => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 15_000);
    }
  }

  listen();
  return () => controller.abort();
}
