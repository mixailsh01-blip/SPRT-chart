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

export function encodeAttendanceCsv(rows) {
  const header = ["Дата", "Сотрудник", "Подразделение", "Статус", "Начало", "Окончание", "Часы"];
  const escape = value => {
    const text = String(value ?? "");
    const safe = /^[\t\r\n]|^\s*[=+\-@]/u.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return "\uFEFF" + [header, ...rows].map(row => row.map(escape).join(";")).join("\r\n") + "\r\n";
}
