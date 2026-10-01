// Табель отпусков (кнопка в меню аватарки): «Планы на отпуск <год>» по полугодиям.
// Данные — существующие отпуска из формы Pyrus «График отпусков» (те же, что в графике).
// Отпуск относится к полугодию по дате начала. У сотрудника несколько периодов — несколько строк.
// Согласование (✓ «Согласован» / «Ожидает») — флажок в Pyrus; менять может тот, у кого canApprove().
// Доступ (кнопка и окно): админы и роль «менеджер по персоналу» (см. canOpen в app.js).

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmtDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function createVacationReport({ vacationsService, apiClient, getEmployees, getEmployeeLine = () => null, canApprove = () => false, showToast = () => {} }) {
  let backdrop = null;
  let keyHandler = null;
  let year = new Date().getFullYear();
  let onlyWithVacations = false;
  let seq = 0;
  const overrides = new Map(); // taskId -> approved: показываем сразу, пока реестр Pyrus не догнал

  function close() {
    backdrop?.remove();
    backdrop = null;
    if (keyHandler) document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }

  // → [{ name, rows: [{ h1: {s,e}|null, h2: {s,e}|null }] }]
  function buildRows(vacations) {
    const people = new Map();
    for (const e of getEmployees() || []) {
      people.set(Number(e.id), { name: e.fullName || e.name || String(e.id), h1: [], h2: [] });
    }
    for (const v of vacations) {
      let p = people.get(Number(v.empId));
      if (!p) {
        p = { name: v.name, h1: [], h2: [] };
        people.set(Number(v.empId), p);
      }
      const startsIn = new Date(v.startMs);
      if (startsIn.getUTCFullYear() < year) {
        // начался в прошлом году — показываем как начало года
        v.startMs = Date.UTC(year, 0, 1);
      } else if (startsIn.getUTCFullYear() > year) {
        continue;
      }
      const approved = overrides.has(v.taskId) ? overrides.get(v.taskId) : v.approved;
      (new Date(v.startMs).getUTCMonth() < 6 ? p.h1 : p.h2).push({ s: v.startMs, e: v.endMs, id: v.taskId, ok: approved });
    }
    const list = [];
    for (const p of people.values()) {
      p.h1.sort((a, b) => a.s - b.s);
      p.h2.sort((a, b) => a.s - b.s);
      const n = Math.max(p.h1.length, p.h2.length, 1);
      if (onlyWithVacations && !p.h1.length && !p.h2.length) continue;
      const rows = [];
      for (let i = 0; i < n; i++) rows.push({ h1: p.h1[i] || null, h2: p.h2[i] || null });
      list.push({ name: p.name, rows });
    }
    return list;
  }

  function toTsv(list) {
    const lines = [["Сотрудник", "1 пол. начало", "1 пол. конец", "1 пол. статус", "2 пол. начало", "2 пол. конец", "2 пол. статус"].join("\t")];
    for (const p of list) {
      p.rows.forEach((r, i) =>
        lines.push([i === 0 ? p.name : "", r.h1 ? fmtDay(r.h1.s) : "", r.h1 ? fmtDay(r.h1.e) : "", r.h1 ? (r.h1.ok ? "согласован" : "не согласован") : "", r.h2 ? fmtDay(r.h2.s) : "", r.h2 ? fmtDay(r.h2.e) : "", r.h2 ? (r.h2.ok ? "согласован" : "не согласован") : ""].join("\t"))
      );
    }
    return lines.join("\n");
  }

  function statusCell(h) {
    const td = el("td", "vac-status");
    if (!h) return td;
    const label = el("span", "vac-label");
    td.appendChild(label);
    const manage = canApprove() && h.id != null;
    const paint = () => {
      td.className = `vac-status ${h.ok ? "vac-ok" : "vac-wait"}${manage ? " vac-click" : ""}`;
      label.textContent = h.ok ? "✓ Согласован" : "Ожидает";
      if (manage) td.title = h.ok ? "Снять согласование" : "Согласовать отпуск";
    };
    paint();
    if (!manage) return td;

    td.addEventListener("click", () => {
      // Сразу меняем статус на экране, запрос уходит в фоне; при ошибке откатываем
      const prev = h.ok;
      const next = !prev;
      const apply = (v) => { h.ok = v; overrides.set(h.id, v); paint(); };
      apply(next);
      apiClient.call("vacation.approve", { task_id: h.id, approved: next }).catch((err) => {
        apply(prev);
        showToast(`Не удалось: ${err.message || err}`);
      });
    });

    const del = el("span", "vac-del", "✕");
    del.title = "Удалить отпуск";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить отпуск ${fmtDay(h.s)} — ${fmtDay(h.e)} из Pyrus?`)) return;
      try {
        await apiClient.call("vacation.delete", { task_id: h.id });
        vacationsService.applyDeleted(h.id);
        overrides.delete(h.id);
        cache.delete(year);
        render();
      } catch (err) {
        showToast(`Не удалось удалить: ${err.message || err}`);
      }
    });
    td.appendChild(del);
    return td;
  }

  // Форма «Добавить отпуск» (только для тех, кто может согласовывать)
  function buildAddBar() {
    const bar = el("div", "settings-row vac-add");
    const sel = el("select", "settings-input");
    sel.appendChild(Object.assign(el("option", null, "Сотрудник…"), { value: "" }));
    for (const e of [...(getEmployees() || [])].sort((a, b) => String(a.fullName).localeCompare(String(b.fullName), "ru"))) {
      sel.appendChild(Object.assign(el("option", null, e.fullName || e.name), { value: String(e.id) }));
    }
    const from = el("input", "settings-input");
    from.type = "date";
    const to = el("input", "settings-input");
    to.type = "date";
    const btn = el("button", "btn primary", "＋ Добавить отпуск");
    btn.type = "button";
    from.addEventListener("change", () => { if (!to.value || to.value < from.value) to.value = from.value; });
    btn.addEventListener("click", async () => {
      if (!sel.value || !from.value || !to.value) return showToast("Выберите сотрудника и даты отпуска");
      const days = Math.round((Date.parse(`${to.value}T00:00:00Z`) - Date.parse(`${from.value}T00:00:00Z`)) / 86400000) + 1;
      if (!(days >= 1)) return showToast("Дата конца раньше даты начала");
      if (days > 90) return showToast("Отпуск не может быть длиннее 90 дней");
      btn.disabled = true;
      btn.textContent = "Добавляю…";
      try {
        const res = await apiClient.call("vacation.create", {
          employee_id: Number(sel.value),
          start_date: from.value,
          days,
          line: getEmployeeLine(Number(sel.value)),
        });
        vacationsService.applyCreated(res && res.task);
        showToast("Отпуск добавлен");
        from.value = "";
        to.value = "";
        cache.delete(year);
        render();
      } catch (err) {
        showToast(`Не удалось добавить: ${err.message || err}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "＋ Добавить отпуск";
      }
    });
    bar.append(sel, el("span", "settings-label", "с"), from, el("span", "settings-label", "по"), to, btn);
    return bar;
  }

  function drawTable(host, list) {
    const table = el("table", "vac-report");
    const thead = el("thead");
    const r1 = el("tr");
    const th0 = el("th", "vac-name", "Сотрудник");
    th0.rowSpan = 3;
    r1.appendChild(th0);
    const title = el("th", "vac-title", `Планы на отпуск ${year}`);
    title.colSpan = 6;
    r1.appendChild(title);
    const r2 = el("tr");
    for (const t of ["1 полугодие", "2 полугодие"]) {
      const th = el("th", "vac-half", t);
      th.colSpan = 3;
      r2.appendChild(th);
    }
    const r3 = el("tr");
    for (let i = 0; i < 2; i++) {
      r3.appendChild(el("th", "vac-sub", "Дата начала"));
      r3.appendChild(el("th", "vac-sub", "Дата конца"));
      r3.appendChild(el("th", "vac-sub", "Согласование"));
    }
    thead.append(r1, r2, r3);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const p of list) {
      p.rows.forEach((r, i) => {
        const tr = el("tr", i === 0 ? "vac-first" : "");
        if (i === 0) {
          const td = el("td", "vac-name", p.name);
          td.rowSpan = p.rows.length;
          tr.appendChild(td);
        }
        for (const h of [r.h1, r.h2]) {
          tr.appendChild(el("td", null, h ? fmtDay(h.s) : ""));
          tr.appendChild(el("td", null, h ? fmtDay(h.e) : ""));
          tr.appendChild(statusCell(h));
        }
        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    host.replaceChildren(table);
  }

  const cache = new Map(); // year -> vacations: показываем сразу, пока грузится свежее

  async function fetchYear(y, force) {
    const data = await vacationsService.getVacationsForYear(y, { force });
    cache.set(y, data);
    return data;
  }

  function paint(host, vacations) {
    const list = buildRows(vacations.map((v) => ({ ...v })));
    if (backdrop) backdrop._list = list;
    drawTable(host, list);
  }

  async function render(force = false) {
    const my = ++seq;
    const host = backdrop.querySelector(".vac-host");
    const cached = cache.get(year);
    if (cached) paint(host, cached);
    else host.replaceChildren(el("div", "settings-muted", "Загрузка…"));
    let vacations;
    try {
      vacations = await fetchYear(year, force);
    } catch (err) {
      if (my !== seq || cached) return;
      host.replaceChildren(el("div", "settings-error", `Не удалось загрузить отпуска: ${err.message || err}`));
      return;
    }
    if (my !== seq || !backdrop) return;
    paint(host, vacations);
  }

  // Прогрев: вызывается при открытии меню профиля, к клику по кнопке данные уже загружены
  function prefetch() {
    fetchYear(year, false).catch(() => {});
  }

  function open() {
    if (backdrop) return;
    backdrop = el("div", "settings-backdrop");
    const modal = el("div", "settings-modal vac-modal");
    const head = el("div", "settings-head");
    head.appendChild(el("div", "settings-title", "🏖 Табель отпусков"));
    const closeBtn = el("button", "btn toggle", "✕");
    closeBtn.type = "button";
    closeBtn.addEventListener("click", close);
    head.appendChild(closeBtn);

    const bar = el("div", "settings-row");
    const prev = el("button", "btn toggle", "‹");
    const next = el("button", "btn toggle", "›");
    const yearLabel = el("strong", null, String(year));
    for (const b of [prev, next]) b.type = "button";
    const setYear = (y) => { year = y; yearLabel.textContent = String(y); render(); };
    prev.addEventListener("click", () => setYear(year - 1));
    next.addEventListener("click", () => setYear(year + 1));
    const onlyLbl = el("label", "settings-label");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = onlyWithVacations;
    cb.addEventListener("change", () => { onlyWithVacations = cb.checked; render(); });
    onlyLbl.append(cb, " Только с отпусками");
    const refresh = el("button", "btn toggle", "↻ Обновить");
    refresh.type = "button";
    refresh.addEventListener("click", () => render(true));
    const copy = el("button", "btn primary", "Копировать");
    copy.type = "button";
    copy.title = "Скопировать таблицу (вставляется в Excel / Google Таблицы)";
    copy.style.marginLeft = "auto";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(toTsv(backdrop._list || []));
        showToast("Табель скопирован");
      } catch (_) {
        showToast("Не удалось скопировать");
      }
    });
    bar.append(prev, yearLabel, next, onlyLbl, refresh, copy);

    const host = el("div", "vac-host settings-body");
    modal.append(head, bar);
    if (canApprove()) modal.appendChild(buildAddBar());
    modal.appendChild(host);
    backdrop.appendChild(modal);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);
    keyHandler = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", keyHandler);
    render();
  }

  return { open, close, prefetch };
}
