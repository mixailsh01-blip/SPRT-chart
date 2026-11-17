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

export async function reviewAttendance({ month, employees, weekends }, download) {
  const fullDays = employees[0]?.cells.length;
  if (!fullDays) throw new Error("В выбранном месяце нет сотрудников для выгрузки");

  const dialog = document.createElement("dialog");
  dialog.className = "attendance-review";
  dialog.setAttribute("aria-labelledby", "attendance-review-title");
  dialog.innerHTML = `
    <h2 id="attendance-review-title">Проверьте табель перед скачиванием</h2>
    <label class="attendance-review-period">
      Период
      <select>
        <option value="payroll">ЗП · весь месяц</option>
        <option value="advance">Аванс · 1–15</option>
      </select>
    </label>
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
  const period = dialog.querySelector(".attendance-review-period select");
  period.options[0].textContent = "ЗП · 1–" + fullDays;
  const summary = dialog.querySelector(".attendance-review-summary");
  const tbody = dialog.querySelector("tbody");
  const save = dialog.querySelector("button.primary");
  const status = dialog.querySelector('[role="status"]');
  const choices = employees.map(person => {
    const row = tbody.insertRow();
    const label = document.createElement("label");
    label.className = "attendance-review-employee";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.setAttribute("aria-label", "Включить в PDF — " + person.name);
    label.append(checkbox, person.name);
    row.insertCell().append(label);
    const values = [row.insertCell(), row.insertCell(), row.insertCell(), row.insertCell()];
    checkbox.addEventListener("change", updateSelection);
    return { person, row, checkbox, values };
  });

  const endDay = () => period.value === "advance" ? 15 : fullDays;
  const selected = () => choices.filter(choice => choice.checkbox.checked);

  function updateSelection() {
    const lastDay = endDay();
    let employeeCount = 0;
    let includedDays = 0;
    let excludedDays = 0;
    let totalMinutes = 0;
    let invalidShift = null;

    for (const { person, row, checkbox, values } of choices) {
      const cells = person.cells.slice(0, lastDay);
      const excluded = cells.filter(cell => cell === "-").length;
      const absences = cells.filter(cell => ["ОТП", "ОГ", "Б"].includes(cell)).length;
      const minutes = cells.reduce((sum, cell) => sum + (Number.isInteger(cell) ? cell : 0), 0);
      const invalidDay = cells.indexOf(null) + 1;
      const included = cells.length - excluded;
      const display = [included, absences, excluded, invalidDay ? "Уточнить" : formatHours(minutes)];
      values.forEach((cell, index) => { cell.textContent = display[index]; });
      row.classList.toggle("attendance-review-omitted", !checkbox.checked);

      if (checkbox.checked) {
        employeeCount++;
        includedDays += included;
        excludedDays += excluded;
        totalMinutes += minutes;
        if (invalidDay && !invalidShift) invalidShift = { name: person.name, day: invalidDay };
      }
    }

    summary.textContent = monthLabel + " · Сотрудников: " + employeeCount + " · Часы: " +
      (invalidShift ? "уточнить" : formatHours(totalMinutes)) + " · Исключено дней: " + excludedDays;
    save.disabled = !includedDays || Boolean(invalidShift);
    status.textContent = invalidShift
      ? "Проверьте часы смены: " + invalidShift.name + ", " + attendanceDate(month, invalidShift.day)
      : !includedDays ? "Выберите сотрудников с днями для выгрузки." : "";
  }

  let downloading = false;
  save.addEventListener("click", async () => {
    const lastDay = endDay();
    const report = {
      month,
      period: period.value,
      employees: selected().map(({ person }) => ({ ...person, cells: person.cells.slice(0, lastDay) })),
      weekends: weekends.filter(day => day <= lastDay),
    };
    downloading = true;
    save.disabled = period.disabled = true;
    for (const { checkbox } of choices) checkbox.disabled = true;
    status.textContent = "Готовим PDF…";
    try {
      await download(report);
      dialog.close();
    } catch (error) {
      status.textContent = error.message || "Не удалось скачать PDF";
    } finally {
      downloading = false;
      save.disabled = period.disabled = false;
      for (const { checkbox } of choices) checkbox.disabled = false;
    }
  });
  period.addEventListener("change", updateSelection);
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
