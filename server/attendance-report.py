import json
import os
import sys

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas


MONTHS = (
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
)
INK = HexColor("#132d3a")
MUTED = HexColor("#476573")
TEAL = HexColor("#07536d")
LINE = HexColor("#d6e0e5")
COLORS = {
    "day": "#00ffff",
    "long": "#00ff00",
    "night": "#6fa8dc",
    "duty": "#ff9900",
    "weekend": "#ff0000",
    "unpaid": "#999999",
    "vacation": "#000000",
    "dismissal": "#ffe599",
    "sick": "#b4a7d6",
    "holiday": "#ffff00",
    "shortened": "#3c78d8",
    "excluded": "#eeeeee",
}
LEGEND = [
    ("day", "8", "Рабочий день 9-18"),
    ("long", "12", "Рабочий день 9-21"),
    ("night", "12", "Ночная смена 21-9"),
    ("duty", "12", "Дежурная смена 11-23"),
    ("weekend", "", "Выходной"),
    ("unpaid", "НО", "Неоплачиваемый отпуск"),
    ("vacation", "О", "Оплачиваемый отпуск"),
    ("dismissal", "У", "Увольнение"),
    ("sick", "Б", "Больничный"),
    ("holiday", "12", "Праздничные дни"),
    ("shortened", "7", "Сокращённый день"),
    ("unpaid", "ОГ", "Отгул"),
    ("excluded", "-", "День исключён из выгрузки"),
]


def cell_style(cell, kind):
    if cell == "ОТП":
        return "vacation", "О"
    if cell == "ОГ":
        return "unpaid", "ОГ"
    if cell == "Б":
        return "sick", "Б"
    if cell == "-":
        return "excluded", "-"
    if cell == "П":
        return "holiday", "П"
    if cell == "В":
        return "weekend", ""
    return kind or ("long" if cell == 720 else "day"), work_hours(cell)


def foreground(kind):
    return white if kind in ("vacation", "shortened") else INK


def work_hours(minutes):
    return f"{minutes / 60:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def hours(minutes):
    return f"{minutes // 60}:{minutes % 60:02d}"


def fitted_text(pdf, text, x, y, width, size):
    while size > 5 and pdfmetrics.stringWidth(text, "DejaVu", size) > width:
        size -= 0.5
    pdf.setFont("DejaVu", size)
    pdf.drawString(x, y, text)


def render(report):
    font_dir = os.environ.get("SPRT_PDF_FONT_DIR", "/usr/share/fonts/truetype/dejavu")
    pdfmetrics.registerFont(TTFont("DejaVu", os.path.join(font_dir, "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont("DejaVuBold", os.path.join(font_dir, "DejaVuSans-Bold.ttf")))
    pdf = Canvas(sys.stdout.buffer, pagesize=landscape(A4), pageCompression=1)
    pdf.setTitle("Табель учёта рабочего времени")
    pdf.setAuthor("СПРТ")

    width, height = landscape(A4)
    year, month = map(int, report["month"].split("-"))
    month_label = f"{MONTHS[month - 1]} {year}"
    employees = report["employees"]
    day_count = len(employees[0]["cells"])
    period_label = "Аванс" if report["period"] == "advance" else "ЗП"
    margin, name_width, total_width = 27, 166, 49
    header_y = height - 107
    table_height = header_y - 109
    page_size = int(table_height // 18.5)
    row_height = min(27, table_height / min(len(employees), page_size))
    text_baseline = row_height / 2 - 3.5
    grid_width = width - margin * 2
    day_width = (grid_width - name_width - total_width) / day_count
    day_left = margin + name_width
    total_left = width - margin - total_width
    page_count = (len(employees) + page_size - 1) // page_size
    cells = [cell for employee in employees for cell in employee["cells"]]
    minutes = sum(value for value in cells if type(value) is int)
    excluded = cells.count("-")

    for page in range(page_count):
        for index, letter in enumerate("SPRT"):
            x = margin + index * 20.34
            pdf.setFillColor(INK)
            pdf.roundRect(x, height - 52, 18, 18, 4, fill=1, stroke=0)
            pdf.setFillColor(white)
            pdf.setFont("DejaVu", 11.5)
            pdf.drawCentredString(x + 9, height - 47, letter)

        pdf.setFillColor(INK)
        pdf.setFont("DejaVuBold", 19)
        pdf.drawString(margin + 94, height - 48, "Табель учёта рабочего времени")
        pdf.setFont("DejaVuBold", 12)
        pdf.drawRightString(width - margin, height - 42, month_label)
        pdf.setFont("DejaVu", 9)
        pdf.drawRightString(width - margin, height - 57, f"{period_label} · 1-{day_count}")
        pdf.setFillColor(MUTED)
        pdf.setFont("DejaVu", 9)
        pdf.drawString(
            margin, height - 72,
            f"Сотрудников: {len(employees)}     Учтено часов: {hours(minutes)}     Исключено дней: {excluded}",
        )

        pdf.setFillColor(TEAL)
        pdf.rect(margin, header_y, grid_width, 23, fill=1, stroke=0)
        pdf.setFillColor(white)
        pdf.setFont("DejaVuBold", 8)
        pdf.drawString(margin + 7, header_y + 8, "Сотрудник")
        for day in range(1, day_count + 1):
            pdf.drawCentredString(day_left + (day - 0.5) * day_width, header_y + 8, str(day))
        pdf.drawCentredString(total_left + total_width / 2, header_y + 8, "Часы")

        for index, person in enumerate(employees[page * page_size:(page + 1) * page_size]):
            y = header_y - (index + 1) * row_height
            background = HexColor("#f8fafb") if index % 2 else white
            pdf.setFillColor(background)
            pdf.rect(margin, y, grid_width, row_height, fill=1, stroke=0)
            pdf.setFillColor(INK)
            name_lines = simpleSplit(person["name"], "DejaVuBold", 8.5, name_width - 14)
            if len(name_lines) > 2:
                name_lines = [name_lines[0], " ".join(name_lines[1:])]
            name_top = text_baseline + 4.5 if len(name_lines) > 1 else text_baseline
            for line_index, line in enumerate(name_lines):
                fitted_text(pdf, line, margin + 7, y + name_top - line_index * 9, name_width - 14, 8.5)

            person_minutes = 0
            for day, cell in enumerate(person["cells"], 1):
                x = day_left + (day - 1) * day_width
                kind = person.get("kinds", [None] * day_count)[day - 1]
                style, label = cell_style(cell, kind)
                pdf.setFillColor(HexColor(COLORS[style]))
                pdf.rect(x, y, day_width, row_height, fill=1, stroke=0)
                pdf.setStrokeColor(LINE)
                pdf.line(x, y, x, y + row_height)
                work = type(cell) is int
                pdf.setFillColor(foreground(style))
                pdf.setFont("DejaVu", 6.3 if work else 7)
                pdf.drawCentredString(x + day_width / 2, y + text_baseline, label)
                if work:
                    person_minutes += cell
            pdf.setStrokeColor(LINE)
            pdf.line(total_left, y, total_left, y + row_height)
            pdf.line(margin, y, width - margin, y)
            pdf.setFillColor(INK)
            pdf.setFont("DejaVuBold", 8)
            pdf.drawCentredString(total_left + total_width / 2, y + text_baseline, hours(person_minutes))

        for item, (kind, label, description) in enumerate(LEGEND):
            column, row = divmod(item, 5)
            x = margin + column * (grid_width / 3)
            y = 87 - row * 13
            pdf.setStrokeColor(LINE)
            pdf.setFillColor(HexColor(COLORS[kind]))
            pdf.rect(x, y - 2, 23, 11, fill=1, stroke=1)
            pdf.setFillColor(foreground(kind))
            pdf.setFont("DejaVuBold", 6.5)
            pdf.drawCentredString(x + 11.5, y + 1, label)
            pdf.setFillColor(INK)
            pdf.setFont("DejaVu", 7)
            pdf.drawString(x + 29, y + 1, description)
        pdf.setFont("DejaVu", 7)
        pdf.setFillColor(MUTED)
        pdf.drawString(margin, 15, "В ячейках указаны рабочие часы. Смена 9-18: 8 часов, 9-17: 7 часов с учётом обеда.")
        pdf.drawRightString(width - margin, 15, f"{page + 1} / {page_count}")
        pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    render(json.load(sys.stdin))
