import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import PDFDocument from "pdfkit";
import type { AttendanceRow } from "../attendance/attendance.service.js";

export function groupAttendance(rows: AttendanceRow[]) {
  const employees = new Map<
    string,
    { employee: AttendanceRow; records: AttendanceRow[] }
  >();
  for (const row of rows) {
    let entry = employees.get(row.employeeId);
    if (!entry) {
      entry = { employee: row, records: [] };
      employees.set(row.employeeId, entry);
    }
    if (row.id) entry.records.push(row);
  }
  return [...employees.values()].sort((a, b) =>
    a.employee.employeeName.localeCompare(b.employee.employeeName) ||
    a.employee.employeeId.localeCompare(b.employee.employeeId),
  );
}

const marks: Record<string, string> = {
  PRESENT: "P",
  ABSENT: "A",
  HALF_DAY: "½",
  LEAVE: "L",
  HOLIDAY: "H",
};

const colors: Record<string, string> = {
  PRESENT: "#529568",
  ABSENT: "#C87767",
  HALF_DAY: "#956620",
  LEAVE: "#42769B",
  HOLIDAY: "#796595",
};

const pdfLegend = "P Present   A Absent   – Unmarked   h Recorded hours";
const excelLegend = "P Present   A Absent   – Unmarked   OT Overtime   h Recorded hours   ½ Half day   L Leave   H Holiday";

function formatHours(hours: number) {
  return `${Number(hours.toFixed(2))} h`;
}

export function attendanceRegister(
  rows: AttendanceRow[],
  start: string,
  end: string,
) {
  const from = DateTime.fromISO(start, { zone: "utc" });
  const to = DateTime.fromISO(end, { zone: "utc" });
  const days = Array.from({ length: to.diff(from, "days").days + 1 }, (_, i) =>
    from.plus({ days: i }),
  );
  return {
    days,
    period: `${start} to ${end}`,
    employees: groupAttendance(rows).map(({ employee, records }) => {
      const byDate = new Map(records.map((row) => [row.workDate, row]));
      const hourly = employee.payType === "HOURLY";
      const present = records.filter((row) => row.status === "PRESENT").length;
      const minutes = records.reduce(
        (sum, row) => sum + (row.regularMinutes || (hourly ? 0 : Math.round(row.totalHours * 60))),
        0,
      );
      const overtime = records.filter((row) => row.isOvertime);
      const overtimeHours = overtime.reduce((sum, row) => sum + (row.otHours ?? 0), 0);
      const overtimeTotal = overtime.some((row) => row.otHours === undefined)
        ? "–"
        : formatHours(overtimeHours);
      const combinedHours = Number((minutes / 60 + overtimeHours).toFixed(2));
      const hours = formatHours(combinedHours);
      const daysPresent = `${present} d`;
      return {
        employee,
        total: hourly ? hours : combinedHours > 0 ? `${daysPresent} / ${hours}` : daysPresent,
        pdfTotal: hourly ? formatHours(minutes / 60) : daysPresent,
        overtimeTotal,
        cells: days.map((day) => {
          const record = byDate.get(day.toISODate()!);
          const status = record?.status || "";
          return {
            label: hourly && record && record.regularMinutes > 0
              ? formatHours(record.regularMinutes / 60)
              : marks[status] || "–",
            color: colors[status],
            overtime: Boolean(record?.isOvertime),
          };
        }),
      };
    }),
  };
}

type Register = ReturnType<typeof attendanceRegister>;

export async function attendanceWorkbook(register: Register) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Attendance", {
    views: [{ state: "frozen", xSplit: 2, ySplit: 2 }],
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:2",
    },
  });
  sheet.columns = [
    { width: 32 },
    { width: 16 },
    ...register.days.map(() => ({ width: 10 })),
    { width: 14 },
    { width: 18 },
  ];
  sheet.addRow([excelLegend]);
  const header = sheet.addRow([
    "Employee",
    "Code",
    ...register.days.map((day) => day.toFormat("d LLL\nccc")),
    "Total OT",
    "Total Hr",
  ]);
  header.height = 32;
  header.eachCell((cell, column) => {
    cell.font = { bold: true, color: { argb: "FF34443B" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: register.days[column - 3]?.weekday > 5 ? "FFE9EFEA" : "FFF3F6F3" },
    };
  });
  for (const { employee, cells, total, overtimeTotal } of register.employees) {
    const row = sheet.addRow([
      employee.employeeName,
      employee.employeeCode,
      ...cells.map(({ label, overtime }) => overtime ? `${label}\nOT` : label),
      overtimeTotal,
      total,
    ]);
    row.height = cells.some((cell) => cell.overtime) ? 30 : 20;
    row.alignment = { vertical: "middle" };
    cells.forEach(({ color, overtime }, index) => {
      const cell = row.getCell(index + 3);
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      if (color) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: `FF${color.slice(1)}` },
        };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      } else {
        cell.font = { color: { argb: "FF67776D" } };
      }
      if (overtime) {
        const border = { style: "medium", color: { argb: "FFF59E0B" } } as const;
        cell.border = { top: border, right: border, bottom: border, left: border };
      }
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function attendancePdf(
  register: Register,
  companyName: string,
  rows: AttendanceRow[],
  formatAmount: (amount: number) => string,
) {
  const margin = 30;
  const employeeWidth = 145;
  const totalWidth = 66;
  const fixedWidth = employeeWidth + totalWidth;
  const pageWidth = Math.max(
    842,
    2 * margin + fixedWidth + register.days.length * 24,
  );
  // Keep every date on the same line, including ranges longer than one month.
  const doc = new PDFDocument({
    size: [595, pageWidth],
    layout: "landscape",
    margin,
  });
  const width = pageWidth - 2 * margin;
  const dayWidth = Math.min(60, (width - fixedWidth) / register.days.length);
  const tableWidth = fixedWidth + register.days.length * dayWidth;
  const totalX = margin + tableWidth - totalWidth;
  const rowHeight = 28;
  const headerHeight = 38;
  let y = 0;
  function text(value: string, x: number, top: number, width: number, align: "left" | "center" = "left") {
    doc.text(value, x, top, { width, align, height: 12, ellipsis: true });
  }
  function header() {
    doc.font("Helvetica-Bold").fontSize(17).fillColor("#17664E");
    doc.text(companyName, margin, margin, { width, height: 28, ellipsis: true });
    doc.font("Helvetica").fontSize(10).fillColor("#34443B");
    doc.text(`Attendance register | ${register.period}`, margin, margin + 25);
    doc.fontSize(8);
    doc.text(pdfLegend, margin, margin + 41, { width });
    y = margin + 62;
    doc.rect(margin, y, tableWidth, headerHeight).fill("#F3F6F3");
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#34443B");
    text("Employee", margin + 7, y + 14, employeeWidth - 14);
    text("Total Hr", totalX, y + 14, totalWidth, "center");
    register.days.forEach((day, index) => {
      const x = margin + employeeWidth + index * dayWidth;
      if (day.weekday > 5) doc.rect(x, y, dayWidth, headerHeight).fill("#E9EFEA");
      doc.fillColor("#34443B").fontSize(8);
      text(day.toFormat("d"), x, y + 4, dayWidth, "center");
      doc.fontSize(7).fillColor("#67776D");
      text(day.toFormat("ccc"), x, y + 15, dayWidth, "center");
      if (!index || day.day === 1) {
        text(day.toFormat("LLL"), x, y + 25, dayWidth, "center");
      }
    });
    y += headerHeight;
  }
  header();
  register.employees.forEach(({ employee, cells, pdfTotal }, index) => {
    if (y + rowHeight > doc.page.height - margin) {
      doc.addPage();
      header();
    }
    if (index % 2) doc.rect(margin, y, tableWidth, rowHeight).fill("#F8FAF8");
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#34443B");
    text(employee.employeeName, margin + 7, y + 4, employeeWidth - 14);
    doc.font("Helvetica").fontSize(8).fillColor("#67776D");
    text(employee.employeeCode, margin + 7, y + 16, employeeWidth - 14);
    doc.fillColor("#34443B");
    text(pdfTotal, totalX, y + 9, totalWidth, "center");
    cells.forEach(({ label, color }, column) => {
      const x = margin + employeeWidth + column * dayWidth;
      if (color) doc.roundedRect(x + 1, y + 3, dayWidth - 2, 22, 3).fill(color);
      doc.font("Helvetica-Bold").fontSize(label.length > 3 ? 7 : 8)
        .fillColor(color ? "#FFFFFF" : "#67776D");
      text(label, x, y + 10, dayWidth, "center");
    });
    y += rowHeight;
  });
  if (!register.employees.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#67776D");
    doc.text("No attendance records for this period.", margin, y + 12);
  }
  const overtime = rows.filter((row) => row.isOvertime);
  if (!overtime.length) return doc;

  const overtimeColumns = [
    { label: "Name", x: margin, width: 145 },
    { label: "OT Hr", x: margin + 145, width: 60 },
    { label: "Amount", x: margin + 205, width: 110 },
    { label: "Remark", x: margin + 315, width: 335 },
  ];
  const overtimeTableWidth = 650;
  const pageBottom = doc.page.height - margin;

  function overtimeHeader(nextRowHeight: number) {
    if (y + 44 + nextRowHeight > pageBottom) {
      doc.addPage();
      y = margin;
    }
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#17664E");
    doc.text("Overtime", margin, y);
    y += 22;
    doc.rect(margin, y, overtimeTableWidth, 22).fill("#F3F6F3");
    doc.fontSize(9).fillColor("#34443B");
    for (const { label, x, width } of overtimeColumns) {
      text(label, x + 7, y + 6, width - 14);
    }
    y += 22;
  }

  y += 22;
  overtime.forEach((row, index) => {
    const values = [
      row.employeeName,
      row.otHours === undefined ? "–" : formatHours(row.otHours),
      row.otAmount === undefined ? "–" : formatAmount(row.otAmount),
      row.otRemark?.replace(/\s+/g, " ").trim() || "–",
    ];
    doc.font("Helvetica").fontSize(9);
    const height = Math.max(rowHeight, ...overtimeColumns.map(({ width }, i) =>
      Math.ceil(doc.heightOfString(values[i], { width: width - 14 })) + 14,
    ));
    if (!index || y + height > pageBottom) {
      overtimeHeader(height);
    }
    if (index % 2) doc.rect(margin, y, overtimeTableWidth, height).fill("#F8FAF8");
    doc.font("Helvetica").fontSize(9).fillColor("#34443B");
    overtimeColumns.forEach(({ x, width }, i) => {
      doc.text(values[i], x + 7, y + 7, { width: width - 14, height: height - 14 });
    });
    y += height;
  });
  return doc;
}
