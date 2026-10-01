// Настройки графика (кнопка в меню аватарки).
//  • «Шаблоны смен» — добавление/удаление строк справочника Pyrus «смены».
//    Админ видит и правит шаблоны для «ВСЕ» и ТП, редактор графика — только ТП.
//  • «Доступ» (только админ) — выдача/снятие ролей «Админ» и «Редактор графика».
// Права проверяет бэкенд (settings.shift.save / settings.shift.delete / settings.role.set);
// здесь они лишь скрывают лишние кнопки.

import { unwrapPyrusData } from "./api/pyrusClient.js";

const TEXT_ALL = "ВСЕ";
const TEXT_TP = "ТП";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function findColumn(headers, configured, fallbacks) {
  const names = headers.map((h) => String(h?.name ?? h ?? "").trim().toLowerCase());
  const candidates = [configured, ...fallbacks].filter(Boolean).map((n) => String(n).toLowerCase());
  for (const c of candidates) {
    const idx = names.indexOf(c);
    if (idx >= 0) return idx;
  }
  for (const c of candidates) {
    const idx = names.findIndex((n) => n.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

// "ТП", "ВСЕ", "" → нормализованный набор токенов
function deptTokens(raw) {
  return String(raw || "")
    .split(/[,/;]/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
}

function deptLabel(raw) {
  const tokens = deptTokens(raw);
  if (tokens.length === 0 || tokens.includes(TEXT_ALL)) return "Все отделы";
  return tokens.join(", ");
}

export function createSettingsPanel({
  apiClient,
  pyrusClient,
  membersService,
  catalogsService,
  catalogId,
  catalogColumns = {},
  getContext, // () => ({ isAdmin, ownId, adminRoleId, editorRoleId })
  onTemplatesChanged, // () => Promise<void>
  showToast = () => {},
}) {
  let backdrop = null;
  let modal = null;
  let body = null;
  let activeTab = "shifts";
  let keyHandler = null;

  // Номер последней отрисовки: устаревшие (медленные) ответы не затирают текущую вкладку
  let renderSeq = 0;
  const setBody = (seq, ...nodes) => { if (seq === renderSeq) body.replaceChildren(...nodes); };

  async function loadTemplates(force = false) {
    // По умолчанию — из кэша, который уже загружен при старте приложения (быстро и без запроса к серверу)
    const raw = await catalogsService.getShiftsCatalog({ catalogId, force });
    const data = unwrapPyrusData(raw);
    const catalog = Array.isArray(data) ? data[0] : data;
    const headers = catalog?.catalog_headers || [];
    const items = catalog?.items || [];
    let idxName = findColumn(headers, catalogColumns.name, ["название смены", "смена", "название"]);
    if (idxName < 0) idxName = 0;
    const idxTime = findColumn(headers, catalogColumns.time, ["время смены", "время"]);
    const idxAmount = findColumn(headers, catalogColumns.amount, ["сумма за смену", "сумма", "стоимость"]);
    const idxDept = findColumn(headers, catalogColumns.departments, ["подразделение", "отдел"]);
    return items.map((it) => {
      const v = it.values || [];
      return {
        itemId: it.item_id,
        name: String(v[idxName] ?? ""),
        time: idxTime >= 0 ? String(v[idxTime] ?? "") : "",
        amount: idxAmount >= 0 ? String(v[idxAmount] ?? "") : "",
        dept: idxDept >= 0 ? String(v[idxDept] ?? "") : "",
      };
    });
  }

  function canManageTemplate(ctx, tpl) {
    if (ctx.isAdmin) return true;
    const tokens = deptTokens(tpl.dept);
    return tokens.length === 1 && tokens[0] === TEXT_TP;
  }

  // ---------- Вкладка «Шаблоны смен» ----------
  async function renderShiftsTab(force = false) {
    const mySeq = ++renderSeq;
    const ctx = getContext();
    setBody(mySeq, el("div", "settings-muted", "Загрузка…"));
    let templates;
    try {
      templates = await loadTemplates(force);
    } catch (err) {
      const box = el("div", "settings-section");
      box.appendChild(el("div", "settings-error", `Не удалось загрузить смены: ${err.message || err}`));
      const retry = el("button", "btn primary", "Повторить");
      retry.type = "button";
      retry.addEventListener("click", () => renderShiftsTab(true));
      box.appendChild(retry);
      setBody(mySeq, box);
      return;
    }

    const wrap = el("div", "settings-section");

    // Фильтр по отделу
    const filterRow = el("div", "settings-row");
    filterRow.appendChild(el("label", "settings-label", "Показать:"));
    const filterSel = el("select", "settings-input");
    [["all", "Все шаблоны"], ["tp", "Только ТП"], ["common", "Только общие (для всех)"]].forEach(([v, t]) => {
      const o = el("option", null, t);
      o.value = v;
      filterSel.appendChild(o);
    });
    filterRow.appendChild(filterSel);
    const refreshBtn = el("button", "btn toggle", "↻ Обновить");
    refreshBtn.type = "button";
    refreshBtn.title = "Загрузить свежий список из Pyrus";
    refreshBtn.addEventListener("click", () => renderShiftsTab(true));
    filterRow.appendChild(refreshBtn);
    const addToggle = el("button", "btn primary", "＋ Добавить смену");
    addToggle.type = "button";
    addToggle.style.marginLeft = "auto";
    filterRow.appendChild(addToggle);
    wrap.appendChild(filterRow);

    const list = el("div", "settings-list");
    wrap.appendChild(list);

    const renderList = () => {
      list.replaceChildren();
      const f = filterSel.value;
      const shown = templates.filter((t) => {
        const tokens = deptTokens(t.dept);
        const common = tokens.length === 0 || tokens.includes(TEXT_ALL);
        if (f === "tp") return tokens.includes(TEXT_TP);
        if (f === "common") return common;
        return true;
      });
      if (!shown.length) list.appendChild(el("div", "settings-muted", "Шаблонов нет"));
      for (const t of shown) {
        const row = el("div", "settings-item");
        const info = el("div", "settings-item-info");
        info.appendChild(el("b", null, t.name));
        info.appendChild(el("span", "settings-muted", ` ${t.time || "—"} · ${t.amount || 0} ₽ · ${deptLabel(t.dept)}`));
        row.appendChild(info);
        if (canManageTemplate(ctx, t)) {
          const del = el("button", "btn toggle settings-danger", "Удалить");
          del.type = "button";
          del.addEventListener("click", async () => {
            if (!confirm(`Удалить шаблон «${t.name}»?\nУже поставленные смены останутся в графике.`)) return;
            del.disabled = true;
            try {
              await apiClient.call("settings.shift.delete", { item_id: t.itemId });
              showToast("Шаблон удалён");
              await onTemplatesChanged?.();
              await renderShiftsTab();
            } catch (err) {
              del.disabled = false;
              alert(`Не удалось удалить: ${err.message || err}`);
            }
          });
          row.appendChild(del);
        }
        list.appendChild(row);
      }
    };
    filterSel.addEventListener("change", renderList);
    renderList();

    // Форма добавления
    const form = el("form", "settings-form hidden");
    form.appendChild(el("div", "settings-subtitle", "Новая смена"));
    const nameIn = el("input", "settings-input");
    nameIn.placeholder = "Название, например «Утро»";
    nameIn.maxLength = 60;
    nameIn.required = true;
    const fromIn = el("input", "settings-input");
    fromIn.type = "time";
    fromIn.required = true;
    const toIn = el("input", "settings-input");
    toIn.type = "time";
    toIn.required = true;
    const amountIn = el("input", "settings-input");
    amountIn.type = "number";
    amountIn.min = "0";
    amountIn.step = "1";
    amountIn.placeholder = "Сумма, ₽";
    amountIn.value = "0";
    const deptSel = el("select", "settings-input");
    const deptOptions = ctx.isAdmin
      ? [[TEXT_TP, "Только ТП"], [TEXT_ALL, "Для всех отделов"]]
      : [[TEXT_TP, "Только ТП"]];
    deptOptions.forEach(([v, t]) => {
      const o = el("option", null, t);
      o.value = v;
      deptSel.appendChild(o);
    });
    const timeRow = el("div", "settings-row");
    timeRow.append(fromIn, el("span", "settings-muted", "—"), toIn);
    const submit = el("button", "btn primary", "Сохранить смену");
    submit.type = "submit";
    const cancel = el("button", "btn toggle", "Отмена");
    cancel.type = "button";
    const btnRow = el("div", "settings-row");
    btnRow.append(submit, cancel);
    form.append(nameIn, timeRow, amountIn, deptSel, btnRow);
    // Форма скрыта, пока не нажата «＋ Добавить смену»
    const setFormOpen = (open) => {
      form.classList.toggle("hidden", !open);
      addToggle.classList.toggle("hidden", open);
      if (open) nameIn.focus();
    };
    addToggle.addEventListener("click", () => setFormOpen(true));
    cancel.addEventListener("click", () => {
      form.reset();
      amountIn.value = "0";
      setFormOpen(false);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) return;
      if (templates.some((t) => t.name.trim().toUpperCase() === name.toUpperCase())) {
        if (!confirm(`Шаблон «${name}» уже есть. Обновить его?`)) return;
      }
      submit.disabled = true;
      try {
        await apiClient.call("settings.shift.save", {
          name,
          time: `${fromIn.value}-${toIn.value}`,
          amount: Number(amountIn.value || 0),
          dept: deptSel.value,
        });
        showToast("Шаблон сохранён");
        await onTemplatesChanged?.();
        await renderShiftsTab();
      } catch (err) {
        submit.disabled = false;
        alert(`Не удалось сохранить: ${err.message || err}`);
      }
    });
    wrap.appendChild(form);
    setBody(mySeq, wrap);
  }

  // ---------- Вкладка «Доступ» (только админ) ----------
  async function renderAccessTab(force = false) {
    const mySeq = ++renderSeq;
    const ctx = getContext();
    if (!ctx.isAdmin) {
      setBody(mySeq, el("div", "settings-error", "Доступно только администратору"));
      return;
    }
    setBody(mySeq, el("div", "settings-muted", "Загрузка…"));
    let roles;
    let members;
    try {
      const [rolesRaw, membersRaw] = await Promise.all([
        pyrusClient.pyrusRequest("/v4/roles", { method: "GET" }),
        membersService.getMembers({ force }),
      ]);
      const rd = unwrapPyrusData(rolesRaw);
      roles = (Array.isArray(rd) ? rd[0] : rd)?.roles || [];
      members = membersService.extractMembersFromPyrusData(membersRaw) || [];
    } catch (err) {
      const box = el("div", "settings-section");
      box.appendChild(el("div", "settings-error", `Не удалось загрузить роли: ${err.message || err}`));
      const retry = el("button", "btn primary", "Повторить");
      retry.type = "button";
      retry.addEventListener("click", () => renderAccessTab(true));
      box.appendChild(retry);
      setBody(mySeq, box);
      return;
    }
    const users = members
      .filter((m) => !m.banned && (!m.type || m.type === "user"))
      .map((m) => ({ id: Number(m.id), name: `${m.last_name || ""} ${m.first_name || ""}`.trim() || m.email || `#${m.id}` }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const nameOf = (id) => users.find((u) => u.id === Number(id))?.name || `#${id}`;
    const roleMembers = (roleId) =>
      new Set((roles.find((r) => Number(r.id) === Number(roleId))?.member_ids || []).map(Number));

    const wrap = el("div", "settings-section");

    const defs = [
      { key: "admin", roleId: ctx.adminRoleId, title: "Администраторы", hint: "Полный доступ: все смены, шаблоны, настройки и выдача ролей." },
      { key: "editor", roleId: ctx.editorRoleId, title: "Редакторы графика", hint: "Правят график всех сотрудников ТП, управляют шаблонами ТП." },
    ];

    const setRole = async (memberId, roleKey, grant) => {
      try {
        await apiClient.call("settings.role.set", { member_id: memberId, role: roleKey, grant });
        showToast(grant ? "Роль выдана" : "Роль снята");
        await renderAccessTab();
      } catch (err) {
        alert(`Не удалось изменить роль: ${err.message || err}`);
      }
    };

    for (const def of defs) {
      const block = el("div", "settings-block");
      block.appendChild(el("div", "settings-subtitle", def.title));
      block.appendChild(el("div", "settings-muted", def.hint));
      const ids = [...roleMembers(def.roleId)].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "ru"));
      if (!ids.length) block.appendChild(el("div", "settings-muted", "Пока никого"));
      for (const id of ids) {
        const row = el("div", "settings-item");
        row.appendChild(el("span", null, nameOf(id)));
        const rm = el("button", "btn toggle settings-danger", "Снять");
        rm.type = "button";
        const self = def.key === "admin" && Number(id) === Number(ctx.ownId);
        if (self) {
          rm.disabled = true;
          rm.title = "Нельзя снять админку с самого себя";
        }
        rm.addEventListener("click", () => {
          if (confirm(`Снять роль «${def.title}» у ${nameOf(id)}?`)) setRole(id, def.key, false);
        });
        row.appendChild(rm);
        block.appendChild(row);
      }
      wrap.appendChild(block);
    }

    // Выдача роли
    const form = el("form", "settings-form");
    form.appendChild(el("div", "settings-subtitle", "Выдать роль"));
    const search = el("input", "settings-input");
    search.placeholder = "Начните вводить фамилию…";
    search.setAttribute("list", "settings-users-list");
    const dl = el("datalist");
    dl.id = "settings-users-list";
    users.forEach((u) => {
      const o = el("option");
      o.value = u.name;
      dl.appendChild(o);
    });
    const roleSel = el("select", "settings-input");
    [["editor", "Редактор графика"], ["admin", "Администратор"]].forEach(([v, t]) => {
      const o = el("option", null, t);
      o.value = v;
      roleSel.appendChild(o);
    });
    const submit = el("button", "btn primary", "Выдать");
    submit.type = "submit";
    form.append(search, dl, roleSel, submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const user = users.find((u) => u.name.toLowerCase() === search.value.trim().toLowerCase());
      if (!user) {
        alert("Выберите сотрудника из списка");
        return;
      }
      const def = defs.find((d) => d.key === roleSel.value);
      if (roleMembers(def.roleId).has(user.id)) {
        alert(`У ${user.name} уже есть роль «${def.title}»`);
        return;
      }
      if (roleSel.value === "admin" && !confirm(`Дать ${user.name} полный доступ (администратор)?`)) return;
      setRole(user.id, roleSel.value, true);
    });
    wrap.appendChild(form);
    setBody(mySeq, wrap);
  }

  // ---------- Каркас окна ----------
  async function showTab(tab) {
    activeTab = tab;
    modal.querySelectorAll(".settings-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    if (tab === "access") await renderAccessTab();
    else await renderShiftsTab();
  }

  function close() {
    backdrop?.remove();
    backdrop = null;
    modal = null;
    document.body.classList.remove("settings-open");
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
  }

  function open() {
    if (backdrop) return;
    const ctx = getContext();
    backdrop = el("div", "settings-backdrop");
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    modal = el("div", "settings-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Настройки");

    const head = el("div", "settings-head");
    head.appendChild(el("div", "settings-title", "⚙️ Настройки"));
    const closeBtn = el("button", "btn toggle", "✕");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Закрыть");
    closeBtn.addEventListener("click", close);
    head.appendChild(closeBtn);

    const tabs = el("div", "settings-tabs");
    const tabShifts = el("button", "settings-tab", "Шаблоны смен");
    tabShifts.type = "button";
    tabShifts.dataset.tab = "shifts";
    tabShifts.addEventListener("click", () => showTab("shifts"));
    tabs.appendChild(tabShifts);
    if (!ctx.isAdmin) {
      const note = el("span", "settings-muted", "Выдача ролей — только у администраторов");
      note.style.marginLeft = "auto";
      note.style.alignSelf = "center";
      tabs.appendChild(note);
    }
    if (ctx.isAdmin) {
      const tabAccess = el("button", "settings-tab", "Доступ");
      tabAccess.type = "button";
      tabAccess.dataset.tab = "access";
      tabAccess.addEventListener("click", () => showTab("access"));
      tabs.appendChild(tabAccess);
    }

    body = el("div", "settings-body");
    modal.append(head, tabs, body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    document.body.classList.add("settings-open");
    keyHandler = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", keyHandler);
    showTab(activeTab === "access" && ctx.isAdmin ? "access" : "shifts");
  }

  return { open, close };
}
