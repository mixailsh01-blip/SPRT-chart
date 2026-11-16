const HEARTBEAT_MS = 15_000;
const CHANGE_EVENT = 'event: schedule\ndata: {}\n\n';

export function createScheduleEvents(portal) {
  const clients = new Set();

  function open(req, res) {
    if (!portal.isAuthenticated(req.headers)) return false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });

    const write = message => {
      if (!portal.isAuthenticated(req.headers)) res.end();
      else if (!res.write(message)) res.destroy();
    };
    const close = () => res.end();
    clients.add(close);
    const unsubscribe = portal.onScheduleChange(() => write(CHANGE_EVENT));
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);
    res.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      clients.delete(close);
    });
    // Подключение и переподключение сверяют график, включая пропущенные изменения.
    write(CHANGE_EVENT);
    return true;
  }

  return { open, close: () => clients.forEach(close => close()) };
}
