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
WEEKEND = HexColor("#edf3f6")
ABSENCE = HexColor("#fbefd9")
VACATION = HexColor("#dff1ea")


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
    weekends = set(report["weekends"])
    margin, name_width, total_width, row_height, page_size = 27, 166, 49, 27, 15
    grid_width = width - margin * 2
    day_width = (grid_width - name_width - total_width) / day_count
    day_left = margin + name_width
    total_left = width - margin - total_width
    page_count = (len(employees) + page_size - 1) // page_size
    cells = [cell for employee in employees for cell in employee["cells"]]
    minutes = sum(value for value in cells if type(value) is int)
    excluded = cells.count("-")

    for page in range(page_count):
        pdf.setFillColor(TEAL)
        pdf.rect(margin, height - 52, 42, 22, fill=1, stroke=0)
        pdf.setFillColor(white)
        pdf.setFont("DejaVuBold", 9)
        pdf.drawCentredString(margin + 21, height - 44, "СПРТ")

        pdf.setFillColor(INK)
        pdf.setFont("DejaVuBold", 21)
        pdf.drawString(margin + 54, height - 48, "Табель учёта рабочего времени")
        pdf.setFont("DejaVuBold", 12)
        pdf.drawRightString(width - margin, height - 45, month_label)
        pdf.setFillColor(MUTED)
        pdf.setFont("DejaVu", 9)
        pdf.drawString(
            margin, height - 72,
            f"Сотрудников: {len(employees)}     Учтено часов: {hours(minutes)}     Исключено дней: {excluded}",
        )

        header_y = height - 107
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
            name_top = 15 if len(name_lines) > 1 else 10
            for line_index, line in enumerate(name_lines):
                fitted_text(pdf, line, margin + 7, y + name_top - line_index * 9, name_width - 14, 8.5)

            person_minutes = 0
            for day, cell in enumerate(person["cells"], 1):
                x = day_left + (day - 1) * day_width
                color = VACATION if cell == "ОТП" else ABSENCE if cell in ("ОГ", "Б") else WEEKEND if day in weekends or cell in ("В", "П", "-") else background
                pdf.setFillColor(color)
                pdf.rect(x, y, day_width, row_height, fill=1, stroke=0)
                pdf.setStrokeColor(LINE)
                pdf.line(x, y, x, y + row_height)
                work = type(cell) is int
                pdf.setFillColor(INK if work or cell in ("ОТП", "ОГ", "Б") else MUTED)
                pdf.setFont("DejaVu", 6.3 if work else 7)
                pdf.drawCentredString(x + day_width / 2, y + 10, hours(cell) if work else cell)
                if work:
                    person_minutes += cell
            pdf.setStrokeColor(LINE)
            pdf.line(total_left, y, total_left, y + row_height)
            pdf.line(margin, y, width - margin, y)
            pdf.setFillColor(INK)
            pdf.setFont("DejaVuBold", 8)
            pdf.drawCentredString(total_left + total_width / 2, y + 10, hours(person_minutes))

        pdf.setFont("DejaVu", 8)
        pdf.setFillColor(MUTED)
        pdf.drawString(margin, 51, "Ячейки со временем показывают часы и минуты смены.")
        pdf.drawString(margin, 37, "ОТП: отпуск    ОГ: отгул    Б: больничный    В: выходной    П: праздник    -: день исключён")
        pdf.drawRightString(width - margin, 37, f"{page + 1} / {page_count}")
        pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    render(json.load(sys.stdin))
