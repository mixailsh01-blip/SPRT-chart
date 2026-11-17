import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./attendance-report.py', import.meta.url));
const codes = new Set(['ОТП', 'ОГ', 'Б', 'П', 'В', '-']);
const validText = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const validCell = value => codes.has(value) || (Number.isInteger(value) && value > 0 && value <= 1440);

export function validateAttendanceReport({ month, employees, weekends }) {
  const invalid = () => Object.assign(new Error('Проверьте даты, сотрудников и часы в табеле'), { status: 400 });
  if (typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) throw invalid();
  const [year, number] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  if (!Array.isArray(employees) || !employees.length || employees.length > 500 ||
      !Array.isArray(weekends) || weekends.length > days ||
      !weekends.every(day => Number.isInteger(day) && day >= 1 && day <= days)) throw invalid();
  const seen = new Set();
  for (const person of employees) {
    if (!person || !Number.isSafeInteger(person.id) || person.id < 1 || seen.has(person.id) ||
        !validText(person.name, 200) || !person.name.trim() || !validText(person.department, 200) ||
        !Array.isArray(person.cells) || person.cells.length !== days || !person.cells.every(validCell)) throw invalid();
    seen.add(person.id);
  }
  if (employees.every(person => person.cells.every(cell => cell === '-'))) {
    throw Object.assign(new Error('В табеле нет дней для выгрузки'), { status: 400 });
  }
  return { month, employees, weekends };
}

export function renderAttendancePdf(report) {
  return new Promise((resolve, reject) => {
    const process = execFile('python3', [script], {
      encoding: 'buffer', timeout: 15_000, maxBuffer: 5 * 1024 * 1024,
    }, (error, pdf) => error ? reject(error) : resolve(pdf));
    process.stdin.on('error', reject);
    process.stdin.end(JSON.stringify(report));
  });
}
