export function isShiftTemplateAvailable(scope, department) {
  const tokens = String(scope || "").split(/[,/;]/)
    .map(value => value.trim().toUpperCase()).filter(Boolean);
  const name = String(department || "").trim().toUpperCase();
  return tokens.length === 0 || tokens.includes("ВСЕ") || tokens.includes("ALL") ||
    Boolean(name && tokens.includes(name));
}
