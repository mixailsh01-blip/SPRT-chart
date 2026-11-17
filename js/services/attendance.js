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
    name: person.name,
    included: person.cells.filter(cell => cell !== "-").length,
    excluded: person.cells.filter(cell => cell === "-").length,
    absences: person.cells.filter(cell => ["ОТП", "ОГ", "Б"].includes(cell)).length,
    minutes: person.cells.reduce((sum, cell) => sum + (Number.isInteger(cell) ? cell : 0), 0),
  }));
  const sum = key => totals.reduce((value, person) => value + person[key], 0);
  const includedDays = sum("included");
  if (!includedDays) throw new Error("В выбранном месяце нет дней для выгрузки");

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
  dialog.querySelector(".attendance-review-summary").textContent =
    monthLabel + " · Сотрудников: " + employees.length + " · Часы: " + formatHours(sum("minutes")) +
    " · Исключено дней: " + sum("excluded");
  const tbody = dialog.querySelector("tbody");
  for (const person of totals) {
    const row = tbody.insertRow();
    for (const value of [person.name, person.included, person.absences, person.excluded, formatHours(person.minutes)]) {
      row.insertCell().textContent = value;
    }
  }
  const save = dialog.querySelector("button.primary");
  const status = dialog.querySelector('[role="status"]');
  save.addEventListener("click", async () => {
    save.disabled = true;
    status.textContent = "Готовим PDF…";
    try {
      await download();
      dialog.close();
    } catch (error) {
      status.textContent = error.message || "Не удалось скачать PDF";
    } finally {
      save.disabled = false;
    }
  });
  const cancel = dialog.querySelector("button[type=submit]");
  cancel.addEventListener("click", event => {
    if (save.disabled) event.preventDefault();
  });
  dialog.addEventListener("cancel", event => {
    if (save.disabled) event.preventDefault();
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
