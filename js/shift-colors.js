// shift-colors.js
// Система динамического назначения цветов для шаблонов смен

const SHIFT_COLORS_STYLE_ID = 'dynamic-shift-colors';
const colorState = {
  theme: 'dark',
  templatesByLine: {},
  templateMetaById: new Map(),
};

// Красный и зелёный зарезервированы под индикатор телефонии (точка в ячейке),
// поэтому смены красим только оттенками синего, фиолетового, бирюзового, оранжевого и т.п.
const SHIFT_HUES = [212, 272, 190, 32, 300, 232, 48, 252, 200, 318, 222, 285];

function generateColorForIndex(index, saturation = 64, lightness = 54, isDark = false) {
  const hue = SHIFT_HUES[index % SHIFT_HUES.length];

  const adjSaturation = isDark ? Math.min(saturation + 6, 76) : saturation;
  const adjLightness = isDark ? Math.min(lightness + 6, 70) : lightness;

  return { hue, saturation: adjSaturation, lightness: adjLightness };
}

function createCSSVariablesForColor(hsl, isDark = false) {
  const bgOpacity = isDark ? 0.2 : 0.14;
  const borderOpacity = isDark ? 0.55 : 0.48;

  return {
    bg: `hsla(${hsl.hue}, ${hsl.saturation}%, ${hsl.lightness}%, ${bgOpacity})`,
    border: `hsla(${hsl.hue}, ${hsl.saturation}%, ${hsl.lightness}%, ${borderOpacity})`,
  };
}

function ensureStyleEl() {
  let styleEl = document.getElementById(SHIFT_COLORS_STYLE_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = SHIFT_COLORS_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  return styleEl;
}

function getTemplateClass(line, templateId) {
  if (!line || templateId == null) return '';
  return `shift-template-${line.toLowerCase()}-${templateId}`;
}

function rebuildColors() {
  const styleEl = ensureStyleEl();
  colorState.templateMetaById.clear();

  const isDark = colorState.theme === 'dark';
  const cssRules = [];

  const lineKeys = Object.keys(colorState.templatesByLine || {});

  lineKeys.forEach((line) => {
    const templates = colorState.templatesByLine[line] || [];
    let colorIndex = 0;

    templates.forEach((template) => {
      const className = getTemplateClass(line, template.id);
      const meta = { line, className, isSpecial: Boolean(template.specialShortLabel) };
      colorState.templateMetaById.set(template.id, meta);

      if (meta.isSpecial) return;

      const colorHSL = generateColorForIndex(colorIndex++, 64, 54, isDark);
      const cssVars = createCSSVariablesForColor(colorHSL, isDark);

      cssRules.push(`
.shift-pill.${className},
.shift-legend-color.${className} {
  background: ${cssVars.bg};
  border-color: ${cssVars.border};
}
      `.trim());
    });
  });

  // Базовый стиль для специальных смен
  cssRules.push(`
.shift-pill.special,
.shift-legend-color.special {
  background: var(--shift-special-bg);
  border-color: var(--shift-special-border);
}
  `.trim());

  styleEl.textContent = cssRules.join('\n');
}

function applyColorToPill(pillEl, templateId, fallbackLine) {
  if (!pillEl || templateId == null) return;

  const meta = colorState.templateMetaById.get(templateId);

  if (meta?.isSpecial) {
    pillEl.classList.add('special');
    return;
  }

  const className = fallbackLine ? getTemplateClass(fallbackLine, templateId) : meta?.className;

  if (className) {
    pillEl.classList.add(className);
  }
}

function renderColorLegend(currentLine) {
  const legendContent = document.getElementById('shift-legend-content');
  if (!legendContent) return;

  const templates = currentLine ? colorState.templatesByLine[currentLine] || [] : [];
  const hasTemplates = templates.length > 0;

  legendContent.innerHTML = '';

  if (!hasTemplates) {
    legendContent.innerHTML = '<div class="muted">Нет шаблонов смен для этой линии.</div>';
    return;
  }

  const group = document.createElement('div');
  group.className = 'shift-legend-group';

  const title = document.createElement('div');
  title.className = 'shift-legend-group-title';
  title.textContent = (window.APP_LINE_LABELS && window.APP_LINE_LABELS[currentLine]) || currentLine;
  group.appendChild(title);

  const items = document.createElement('div');
  items.className = 'shift-legend-items';

  templates.forEach((template) => {
    const item = document.createElement('div');
    item.className = 'shift-legend-item';

    const color = document.createElement('div');
    color.className = 'shift-legend-color';

    if (template.specialShortLabel) {
      color.classList.add('special');
    } else {
      const className = getTemplateClass(currentLine, template.id);
      if (className) {
        color.classList.add(className);
      }
    }

    const label = document.createElement('span');
    const timeLabel = template.timeRange
      ? ` (${template.timeRange.start}–${template.timeRange.end})`
      : '';
    label.textContent = `${template.name}${timeLabel}`;

    item.appendChild(color);
    item.appendChild(label);
    items.appendChild(item);
  });

  group.appendChild(items);
  legendContent.appendChild(group);
}

function initialize(templatesByLine, theme = 'dark') {
  colorState.templatesByLine = templatesByLine || {};
  colorState.theme = theme === 'light' ? 'light' : 'dark';
  rebuildColors();
}

function applyTheme(theme) {
  colorState.theme = theme === 'light' ? 'light' : 'dark';
  rebuildColors();
}

if (typeof window !== 'undefined') {
  window.ShiftColors = {
    initialize,
    applyTheme,
    renderColorLegend,
    applyColorToPill,
    getTemplateClass,
  };
}
