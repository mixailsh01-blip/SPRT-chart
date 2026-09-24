function prodCalCacheKey(prodCalConfig, year, monthIndex) {
  const mm = String(monthIndex + 1).padStart(2, "0");
  const prefix = prodCalConfig.cacheKeyPrefix || "";
  return `${prefix}${year}-${mm}_pre1`;
}

function formatYmdCompact(year, monthIndex, day) {
  const mm = String(monthIndex + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}${mm}${dd}`;
}

export function createProdCalendarService({ config }) {
  const prodCalConfig = config?.calendar?.prodCal || {};

  async function getProdCalendarForMonth(year, monthIndex) {
    const cacheKey = prodCalCacheKey(prodCalConfig, year, monthIndex);
    const ttlMs = Number(prodCalConfig.ttlMs) || 0;
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (
          cached &&
          cached.fetchedAt &&
          ttlMs > 0 &&
          Date.now() - cached.fetchedAt < ttlMs &&
          cached.dayTypeByDay
        ) {
          return cached;
        }
      }
    } catch (_) {
      // ignore cache errors
    }

    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    const urlTemplate = prodCalConfig.urlTemplate;
    if (!urlTemplate) {
      throw new Error("ProdCal urlTemplate is missing in config");
    }
    const month = String(monthIndex + 1).padStart(2, "0");
    const date1 = formatYmdCompact(year, monthIndex, 1);
    const date2 = formatYmdCompact(year, monthIndex, lastDay);
    const url = String(urlTemplate)
      .replace(/{year}/g, String(year))
      .replace(/{month}/g, month)
      .replace(/{lastDay}/g, String(lastDay))
      .replace(/{date1}/g, date1)
      .replace(/{date2}/g, date2);

    const resp = await fetch(url, { method: "GET" });
    const text = (await resp.text()).trim();

    if (!resp.ok || /^(100|101|199)$/.test(text) || text.length < lastDay) {
      throw new Error(`ProdCal error: ${resp.status} ${text}`);
    }

    const dayTypeByDay = Object.create(null);
    for (let d = 1; d <= lastDay; d++) {
      const ch = text[d - 1];
      const code =
        ch === "0"
          ? 0
          : ch === "1"
            ? 1
            : ch === "2"
              ? 2
              : ch === "4"
                ? 4
                : ch === "8"
                  ? 8
                  : null;
      if (code !== null) dayTypeByDay[d] = code;
    }

    const payload = {
      monthKey: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
      fetchedAt: Date.now(),
      dayTypeByDay,
    };

    try {
      localStorage.setItem(cacheKey, JSON.stringify(payload));
    } catch (_) {
      // ignore storage quota / privacy mode
    }

    return payload;
  }

  return { getProdCalendarForMonth };
}
