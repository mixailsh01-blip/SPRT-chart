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
    if cell == "У":
        return "dismissal", "У"
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
    margin, name_width, total_width = 27, 144, 44
    header_y = height - 82
    table_height = header_y - 98
    page_size = int(table_height // 18)
    row_height = 18
    text_baseline = row_height / 2 - 2.5
    grid_width = min(width - margin * 2, name_width + total_width + day_count * 25)
    day_width = (grid_width - name_width - total_width) / day_count
    day_left = margin + name_width
    table_right = margin + grid_width
    total_left = table_right - total_width
    page_count = (len(employees) + page_size - 1) // page_size
    cells = [cell for employee in employees for cell in employee["cells"]]
    minutes = sum(value for value in cells if type(value) is int)
    excluded = cells.count("-")

    for page in range(page_count):
        for index, letter in enumerate("SPRT"):
            x = margin + index * 15.82
            pdf.setFillColor(INK)
            pdf.roundRect(x, height - 41, 14, 14, 3, fill=1, stroke=0)
            pdf.setFillColor(white)
            pdf.setFont("DejaVu", 7.5)
            pdf.drawCentredString(x + 7, height - 37, letter)

        pdf.setFillColor(INK)
        pdf.setFont("DejaVuBold", 14)
        pdf.drawString(margin + 73, height - 38, "Табель учёта рабочего времени")
        pdf.setFont("DejaVuBold", 9)
        pdf.drawRightString(table_right, height - 32, month_label)
        pdf.setFont("DejaVu", 7.5)
        pdf.drawRightString(table_right, height - 44, f"{period_label} · 1-{day_count}")
        pdf.setFillColor(MUTED)
        pdf.setFont("DejaVu", 7.5)
        pdf.drawString(
            margin, height - 57,
            f"Сотрудников: {len(employees)}     Учтено часов: {hours(minutes)}     Исключено дней: {excluded}",
        )

        pdf.setFillColor(TEAL)
        pdf.rect(margin, header_y, grid_width, 17, fill=1, stroke=0)
        pdf.setFillColor(white)
        pdf.setFont("DejaVuBold", 6.5)
        pdf.drawString(margin + 7, header_y + 5.5, "Сотрудник")
        for day in range(1, day_count + 1):
            pdf.drawCentredString(day_left + (day - 0.5) * day_width, header_y + 5.5, str(day))
        pdf.drawCentredString(total_left + total_width / 2, header_y + 5.5, "Часы")

        for index, person in enumerate(employees[page * page_size:(page + 1) * page_size]):
            y = header_y - (index + 1) * row_height
            background = HexColor("#f8fafb") if index % 2 else white
            pdf.setFillColor(background)
            pdf.rect(margin, y, grid_width, row_height, fill=1, stroke=0)
            pdf.setFillColor(INK)
            name_lines = simpleSplit(person["name"], "DejaVu", 7, name_width - 14)
            if len(name_lines) > 2:
                name_lines = [name_lines[0], " ".join(name_lines[1:])]
            name_top = text_baseline + 3.5 if len(name_lines) > 1 else text_baseline
            for line_index, line in enumerate(name_lines):
                fitted_text(pdf, line, margin + 7, y + name_top - line_index * 7, name_width - 14, 7)

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
                pdf.setFont("DejaVu", 6)
                pdf.drawCentredString(x + day_width / 2, y + text_baseline, label)
                if work:
                    person_minutes += cell
            pdf.setStrokeColor(LINE)
            pdf.line(total_left, y, total_left, y + row_height)
            pdf.line(margin, y, table_right, y)
            pdf.setFillColor(INK)
            pdf.setFont("DejaVuBold", 6.5)
            pdf.drawCentredString(total_left + total_width / 2, y + text_baseline, hours(person_minutes))

        rows_on_page = min(page_size, len(employees) - page * page_size)
        legend_top = header_y - rows_on_page * row_height - 18
        for item, (kind, label, description) in enumerate(LEGEND):
            column, row = divmod(item, 5)
            x = margin + column * (grid_width / 3)
            y = legend_top - row * 11
            pdf.setStrokeColor(LINE)
            pdf.setFillColor(HexColor(COLORS[kind]))
            pdf.rect(x, y - 2, 18, 9, fill=1, stroke=1)
            pdf.setFillColor(foreground(kind))
            pdf.setFont("DejaVuBold", 6)
            pdf.drawCentredString(x + 9, y + 1, label)
            pdf.setFillColor(INK)
            pdf.setFont("DejaVu", 6)
            pdf.drawString(x + 23, y + 1, description)
        pdf.setFont("DejaVu", 6)
        pdf.setFillColor(MUTED)
        pdf.drawString(margin, legend_top - 61, "В ячейках указаны рабочие часы. Смена 9-18: 8 часов, 9-17: 7 часов с учётом обеда.")
        pdf.drawRightString(table_right, legend_top - 61, f"{page + 1} / {page_count}")
        pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    render(json.load(sys.stdin))
