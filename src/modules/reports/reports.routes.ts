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
  pagination,
  monthSchema,
  objectId,
  currency,
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
      "Department",
      "Date",
      "Status",
      "Hours",
      "Incomplete",
      ...(withPay ? [`OT (${currencyCode}, minor units)`, "OT remark"] : []),
    ],
    ...rows.map((r) => [
      r.employeeName,
      r.employeeCode,
      r.department,
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
  const rows = await attendanceRows(req, query),
    { page, limit } = pagination(req.query);
  res.json({
    data: rows.slice((page - 1) * limit, page * limit),
    meta: { page, limit, total: rows.length, summary: summarize(rows) },
  });
});
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
    const format = z.enum(["csv", "xlsx", "pdf"]).parse(req.query.format);
    const rows = await attendanceRows(req, req.query),
      company = await context();
    const table = reportTable(rows, company.currency);
    res.attachment(`Attendance_${today(company.timezone)}.${format}`);
    if (format === "csv") {
      res.type("text/csv").send(csv(table));
      return;
    }
    if (format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Attendance");
      table.forEach((row) => sheet.addRow(row.map(safeCell)));
      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF17664E" },
      };
      sheet.columns.forEach((column) => {
        column.width = 24;
      });
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      res
        .type(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .send(Buffer.from(await workbook.xlsx.writeBuffer()));
      return;
    }
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.type("application/pdf");
    doc.pipe(res);
    doc.fontSize(20).text(`${company.name} | Attendance report`).moveDown();
    doc
      .fontSize(10)
      .text(
        `${rows.length} records. Times are recorded in ${company.timezone}.`,
      )
      .moveDown();
    for (const row of rows) {
      if (doc.y > 730) doc.addPage();
      doc
        .fontSize(10)
        .text(`${row.employeeName} (${row.employeeCode}) | ${row.workDate}`, {
          continued: false,
        });
      doc
        .fillColor("#555555")
        .text(
          `${row.department} | ${row.status} | ${row.totalHours.toFixed(1)}h${row.otAmount !== undefined ? ` | OT: ${currency(row.otAmount, company.currency)}` : ""}`,
        )
        .fillColor("#111111")
        .moveDown(0.7);
    }
    doc.end();
  },
);
reportsRouter.get("/payroll/monthly", async (req, res) => {
  assert(
    req.auth!.user.role !== "CUSTOMER",
    403,
    "FORBIDDEN",
    "Salary reports are not available to Customers.",
  );
  const month = monthSchema.parse(req.query.month),
    employeeId = objectId.optional().parse(req.query.employeeId);
  const department = z.string().max(120).optional().parse(req.query.department);
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
      ...(department ? [{ department }] : []),
      ...(match
        ? [
            {
              $or: [
                { fullName: match },
                { employeeCode: match },
                { department: match },
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
    department: employee.department,
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
  const departments = [...new Set(rows.map((r) => r.department))].map(
    (name) => ({
      name,
      total: rows.filter((r) => r.department === name).length,
      present: rows.filter(
        (r) => r.department === name && r.status === "PRESENT",
      ).length,
    }),
  );
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
      departments,
      recent: rows
        .filter((r) => r.inTime)
        .sort((a, b) => +new Date(b.inTime!) - +new Date(a.inTime!))
        .slice(0, 5),
    },
  });
});
