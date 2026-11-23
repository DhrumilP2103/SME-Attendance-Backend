import { Router } from "express";
import { z } from "zod";
import { DateTime } from "luxon";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Employee, Attendance } from "../models.js";
import {
  assert,
  context,
  today,
  dateRange,
  pagination,
  monthSchema,
  objectId,
  escapeRegex,
} from "../../lib/core.js";
import {
  employeeScope,
  requirePermission,
  canSeePay,
} from "../roles/permissions.js";
import {
  attendanceRows,
  summarize,
  type AttendanceRow,
} from "../attendance/attendance.service.js";
import {
  attendancePdf,
  attendanceRegister,
  attendanceWorkbook,
  groupAttendance,
} from "./attendance-register.js";
import { calculatePayroll } from "../payroll/payroll.service.js";

export const reportsRouter = Router();
export const safeCell = (value: unknown) => {
  const s = String(value ?? "");
  return /^[\s]*[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
export function csv(rows: unknown[][]) {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row.map((v) => `"${safeCell(v).replace(/"/g, '""')}"`).join(","),
      )
      .join("\r\n")
  );
}
export function reportTable(rows: AttendanceRow[], currencyCode: string) {
  const withPay = rows.some((r) => r.otAmount !== undefined);
  return [
    [
      "Employee",
      "Code",
      "Date",
      "Status",
      "Hours",
      "Incomplete",
      ...(withPay ? [`OT (${currencyCode}, minor units)`, "OT remark"] : []),
    ],
    ...rows.map((r) => [
      r.employeeName,
      r.employeeCode,
      r.workDate,
      r.status,
      r.totalHours.toFixed(2),
      r.isIncomplete ? "Yes" : "No",
      ...(withPay ? [r.otAmount ?? "", r.otRemark ?? ""] : []),
    ]),
  ];
}
function reportAccess(req: Express.Request) {
  assert(
    req.auth!.permissions.canGenerateReports ||
      req.auth!.user.role === "EMPLOYEE" ||
      req.auth!.user.role === "HR",
    403,
    "FORBIDDEN",
    "Report access is unavailable.",
  );
}
reportsRouter.get("/reports/attendance", async (req, res) => {
  reportAccess(req);
  const query = req.auth!.permissions.canGenerateReports
    ? req.query
    : {
        ...req.query,
        employeeId: String(
          (await Employee.findOne({ userId: req.auth!.user._id }))?._id ||
            "000000000000000000000000",
        ),
      };
  const register = req.query.view === "register";
  const rows = await attendanceRows(req, query, register),
    { page, limit } = pagination(req.query);
  const data = register ? groupAttendance(rows) : rows;
  const summaryRows = register && req.query.from !== req.query.to
    ? rows.filter((row) => row.id)
    : rows;
  res.json({
    data: data.slice((page - 1) * limit, page * limit),
    meta: { page, limit, total: data.length, summary: summarize(summaryRows) },
  });
});
function moneyText(value: number, code: string) {
  const digits =
    new Intl.NumberFormat("en", { style: "currency", currency: code })
      .resolvedOptions().maximumFractionDigits ?? 2;
  return `${code} ${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value / 10 ** digits)}`;
}
reportsRouter.get(
  "/reports/attendance/export",
  requirePermission("canExportReports"),
  async (req, res) => {
    assert(
      req.auth!.permissions.canGenerateReports,
      403,
      "FORBIDDEN",
      "Report generation permission is required.",
    );
    const format = z.enum(["xlsx", "pdf"]).parse(req.query.format);
    const company = await context();
    const { start, end } = dateRange(
      req.query.from,
      req.query.to,
      today(company.timezone),
    );
    const rows = await attendanceRows(req, { ...req.query, from: start, to: end }, true);
    const register = attendanceRegister(rows, start, end);
    const filename = `Attendance_${start}_${end}.${format}`;
    if (format === "xlsx") {
      const workbook = await attendanceWorkbook(register);
      res.attachment(filename)
        .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .send(workbook);
      return;
    }
    const doc = attendancePdf(register, company.name, rows, (amount) =>
      moneyText(amount, company.currency),
    );
    res.attachment(filename).type("application/pdf");
    doc.pipe(res);
    doc.end();
  },
);
reportsRouter.get("/payroll/monthly", async (req, res) => {
  const month = monthSchema.parse(req.query.month),
    employeeId = objectId.optional().parse(req.query.employeeId);
  const { page, limit } = pagination(req.query),
    company = await context();
  const scope = canSeePay(req)
    ? await employeeScope(req)
    : { userId: req.auth!.user._id };
  const search = z.string().trim().max(100).optional().parse(req.query.search);
  const match = search ? new RegExp(escapeRegex(search), "i") : undefined;
  const filter = {
    $and: [
      scope,
      ...(employeeId ? [{ _id: employeeId }] : []),
      ...(match
        ? [
            {
              $or: [
                { fullName: match },
                { employeeCode: match },
              ],
            },
          ]
        : []),
    ],
    joiningDate: {
      $lte: DateTime.fromISO(`${month}-01`).endOf("month").toISODate()!,
    },
  };
  const [employees, total] = await Promise.all([
    Employee.find(filter)
      .sort({ fullName: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Employee.countDocuments(filter),
  ]);
  const records = await Attendance.find({
    employeeId: { $in: employees.map((e) => e._id) },
    workDate: { $gte: `${month}-01`, $lte: `${month}-31` },
  }).lean();
  const data = employees.map((employee) => ({
    employeeId: employee._id,
    employeeName: employee.fullName,
    employeeCode: employee.employeeCode,
    payType: employee.payType,
    month,
    currency: company.currency,
    ...calculatePayroll(
      employee,
      records.filter((r) => String(r.employeeId) === String(employee._id)),
      month,
      today(company.timezone),
    ),
  }));
  res.json({ data, meta: { page, limit, total } });
});
reportsRouter.get(
  "/reports/payroll/export",
  requirePermission("canExportReports"),
  async (req, res) => {
    assert(
      req.auth!.permissions.canGenerateReports,
      403,
      "FORBIDDEN",
      "Report generation permission is required.",
    );
    const format = z.enum(["xlsx", "pdf"]).parse(req.query.format),
      month = monthSchema.parse(req.query.month),
      employeeId = objectId.optional().parse(req.query.employeeId),
      search = z.string().trim().max(100).optional().parse(req.query.search);
    const company = await context(),
      scope = canSeePay(req)
        ? await employeeScope(req)
        : { userId: req.auth!.user._id },
      match = search ? new RegExp(escapeRegex(search), "i") : undefined;
    const employees = await Employee.find({
      $and: [
        scope,
        ...(employeeId ? [{ _id: employeeId }] : []),
        ...(match
          ? [{ $or: [{ fullName: match }, { employeeCode: match }] }]
          : []),
      ],
      joiningDate: {
        $lte: DateTime.fromISO(`${month}-01`).endOf("month").toISODate()!,
      },
    })
      .sort({ fullName: 1, _id: 1 })
      .lean();
    const records = await Attendance.find({
      employeeId: { $in: employees.map((e) => e._id) },
      workDate: { $gte: `${month}-01`, $lte: `${month}-31` },
    }).lean();
    const rows = employees.map((employee) => ({
      employeeName: employee.fullName,
      employeeCode: employee.employeeCode,
      ...calculatePayroll(
        employee,
        records.filter((r) => String(r.employeeId) === String(employee._id)),
        month,
        today(company.timezone),
      ),
    }));
    const table = [
      [
        "Employee",
        "Code",
        "Base pay",
        "Deductions",
        "Approved OT",
        "Net (estimate)",
        "Currency",
      ],
      ...rows.map((r) => [
        r.employeeName,
        r.employeeCode,
        (r.basePay / 100).toFixed(2),
        (r.deductions / 100).toFixed(2),
        (r.approvedOt / 100).toFixed(2),
        (r.netPayable / 100).toFixed(2),
        company.currency,
      ]),
    ];
    res.attachment(`Salary_${month}.${format}`);
    if (format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Salary");
      table.forEach((row) => sheet.addRow(row.map(safeCell)));
      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF17664E" },
      };
      sheet.columns.forEach((column) => {
        column.width = 22;
      });
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      res
        .type(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .send(Buffer.from(await workbook.xlsx.writeBuffer()));
      return;
    }
    const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
    res.type("application/pdf");
    doc.pipe(res);
    const contentWidth = doc.page.width - 80;
    const columns = [
      { label: "Employee", x: 40, width: 150, align: "left" as const },
      { label: "Code", x: 195, width: 55, align: "left" as const },
      { label: "Base", x: 255, width: 75, align: "right" as const },
      { label: "Deductions", x: 335, width: 75, align: "right" as const },
      { label: "OT", x: 415, width: 65, align: "right" as const },
      { label: "Net", x: 485, width: 70, align: "right" as const },
    ];
    const rowHeight = 22;
    doc.rect(0, 0, doc.page.width, 96).fill("#17664e");
    doc
      .fillColor("#ffffff")
      .fontSize(18)
      .text(company.name, 40, 32, { width: contentWidth });
    doc.fontSize(10).fillColor("#cfe4da").text("Salary report", 40, 58);
    doc
      .fontSize(9)
      .fillColor("#5c6661")
      .text(
        `${rows.length} employee${rows.length === 1 ? "" : "s"} · ${month} · ${company.currency} · Estimates only`,
        40,
        112,
        { width: contentWidth },
      );
    let y = 140;
    const drawHeader = () => {
      doc.rect(40, y, contentWidth, rowHeight).fill("#eef5f1");
      columns.forEach((c) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor("#3f4b45")
          .text(c.label.toUpperCase(), c.x + 4, y + 7, {
            width: c.width - 8,
            align: c.align,
            lineBreak: false,
          });
      });
      doc.font("Helvetica");
      y += rowHeight;
    };
    drawHeader();
    rows.forEach((row, index) => {
      if (y + rowHeight > 760) {
        doc.addPage();
        y = 40;
        drawHeader();
      }
      if (index % 2) doc.rect(40, y, contentWidth, rowHeight).fill("#f9fbfa");
      const cells = [
        row.employeeName,
        row.employeeCode,
        moneyText(row.basePay, company.currency),
        moneyText(row.deductions, company.currency),
        moneyText(row.approvedOt, company.currency),
        moneyText(row.netPayable, company.currency),
      ];
      columns.forEach((c, i) => {
        doc
          .fontSize(9)
          .fillColor(i === 5 ? "#17664e" : "#26312b")
          .text(String(cells[i] ?? ""), c.x + 4, y + 7, {
            width: c.width - 8,
            align: c.align,
            lineBreak: false,
            ellipsis: true,
          });
      });
      y += rowHeight;
    });
    if (!rows.length)
      doc
        .fontSize(10)
        .fillColor("#5c6661")
        .text("No employees matched this month.", 40, y + 6, {
          width: contentWidth,
        });
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      doc
        .fontSize(8)
        .fillColor("#8b958f")
        .text(
          `Page ${i + 1} of ${pages.count}`,
          40,
          doc.page.height - 30,
          { width: contentWidth, align: "right", lineBreak: false },
        );
    }
    doc.end();
  },
);
reportsRouter.get("/dashboard/summary", async (req, res) => {
  const company = await context(),
    date = today(company.timezone);
  const rows = await attendanceRows(req, { from: date, to: date });
  const history = await attendanceRows(req, {
    from: DateTime.fromISO(date).minus({ days: 6 }).toISODate(),
    to: date,
  });
  const summary = summarize(rows);
  const trend = Array.from({ length: 7 }, (_, i) => {
    const day = DateTime.fromISO(date).minus({ days: 6 - i });
    return {
      date: day.toISODate(),
      label: day.toFormat("ccc"),
      ...summarize(history.filter((r) => r.workDate === day.toISODate())),
    };
  });
  const people = await Employee.countDocuments({
    $and: [await employeeScope(req), { status: "ACTIVE" }],
  });
  res.json({
    data: {
      date,
      company,
      ...summary,
      headcount: people,
      attendanceRate: rows.length
        ? Math.round((summary.present / rows.length) * 100)
        : 0,
      trend,
      recent: rows
        .filter((r) => r.inTime)
        .sort((a, b) => +new Date(b.inTime!) - +new Date(a.inTime!))
        .slice(0, 5),
    },
  });
});
