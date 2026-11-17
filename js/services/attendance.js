export const ABSENCE_LABELS = {
  day_off: { short: "ОГ", label: "Отгул" },
  sick: { short: "Б", label: "Больничный" },
};

export function attendanceDate(month, day) {
  return month + "-" + String(day).padStart(2, "0");
}

export function indexAttendance(rows) {
  return new Map(rows.map(row => [row.date + ":" + row.employee_id, row]));
}

function formatHours(minutes) {
  return Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0");
}

export async function reviewAttendance({ month, employees }, download) {
  const totals = employees.map(person => ({
    person,
    included: person.cells.filter(cell => cell !== "-").length,
    excluded: person.cells.filter(cell => cell === "-").length,
    absences: person.cells.filter(cell => ["ОТП", "ОГ", "Б"].includes(cell)).length,
    minutes: person.cells.reduce((sum, cell) => sum + (Number.isInteger(cell) ? cell : 0), 0),
  }));
  if (!totals.some(total => total.included)) throw new Error("В выбранном месяце нет дней для выгрузки");

  const dialog = document.createElement("dialog");
  dialog.className = "attendance-review";
  dialog.setAttribute("aria-labelledby", "attendance-review-title");
  dialog.innerHTML = `
    <h2 id="attendance-review-title">Проверьте табель перед скачиванием</h2>
    <p class="attendance-review-summary"></p>
    <div class="attendance-review-table">
      <table>
        <thead><tr><th scope="col">Сотрудник</th><th scope="col">Дней в PDF</th><th scope="col">Отсутствия</th><th scope="col">Исключено</th><th scope="col">Часы</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <p role="status"></p>
    <form method="dialog" class="attendance-review-actions">
      <button class="btn" type="submit" autofocus>Отмена</button>
      <button class="btn primary" type="button">Скачать PDF</button>
    </form>`;
  const [year, monthIndex] = month.split("-").map(Number);
  const monthLabel = new Intl.DateTimeFormat("ru", { month: "long", year: "numeric" })
    .format(new Date(year, monthIndex - 1, 1));
  const summary = dialog.querySelector(".attendance-review-summary");
  const tbody = dialog.querySelector("tbody");
  const save = dialog.querySelector("button.primary");
  const status = dialog.querySelector('[role="status"]');
  const choices = totals.map(total => {
    const row = tbody.insertRow();
    const label = document.createElement("label");
    label.className = "attendance-review-employee";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.setAttribute("aria-label", "Включить в PDF — " + total.person.name);
    label.append(checkbox, total.person.name);
    row.insertCell().append(label);
    for (const value of [total.included, total.absences, total.excluded, formatHours(total.minutes)]) {
      row.insertCell().textContent = value;
    }
    checkbox.addEventListener("change", updateSelection);
    return { ...total, row, checkbox };
  });

  const selected = () => choices.filter(choice => choice.checkbox.checked);

  function updateSelection() {
    const included = selected();
    const sum = key => included.reduce((value, choice) => value + choice[key], 0);
    summary.textContent = monthLabel + " · Сотрудников: " + included.length + " · Часы: " +
      formatHours(sum("minutes")) + " · Исключено дней: " + sum("excluded");
    for (const choice of choices) choice.row.classList.toggle("attendance-review-omitted", !choice.checkbox.checked);
    save.disabled = !sum("included");
    status.textContent = save.disabled ? "Выберите сотрудников с днями для выгрузки." : "";
  }

  let downloading = false;
  save.addEventListener("click", async () => {
    const people = selected().map(choice => choice.person);
    downloading = true;
    save.disabled = true;
    for (const { checkbox } of choices) checkbox.disabled = true;
    status.textContent = "Готовим PDF…";
    try {
      await download(people);
      dialog.close();
    } catch (error) {
      status.textContent = error.message || "Не удалось скачать PDF";
    } finally {
      downloading = false;
      save.disabled = false;
      for (const { checkbox } of choices) checkbox.disabled = false;
    }
  });
  updateSelection();
  const cancel = dialog.querySelector("button[type=submit]");
  cancel.addEventListener("click", event => {
    if (downloading) event.preventDefault();
  });
  dialog.addEventListener("cancel", event => {
    if (downloading) event.preventDefault();
  });
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve();
    }, { once: true });
    dialog.showModal();
  });
}
