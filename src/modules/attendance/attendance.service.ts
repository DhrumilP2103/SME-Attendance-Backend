import { z } from "zod";
import { Attendance, Employee, statuses } from "../models.js";
import { employeeScope, canSeePay } from "../roles/permissions.js";
import {
  assert,
  context,
  dateRange,
  today,
  objectId,
  escapeRegex,
} from "../../lib/core.js";

export interface AttendanceRow {
  id: string | null;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  department: string;
  designation: string;
  workDate: string;
  status: string;
  inTime: Date | null;
  outTime: Date | null;
  totalHours: number;
  regularMinutes: number;
  regularApproved: boolean;
  isIncomplete: boolean;
  isOvertime: boolean;
  otAmount?: number;
  otRemark?: string;
  version: number;
  shiftStart: string;
  email: string;
}
export function summarize(rows: AttendanceRow[]) {
  return {
    total: rows.length,
    present: rows.filter((r) => r.status === "PRESENT").length,
    absent: rows.filter((r) => r.status === "ABSENT").length,
    halfDay: rows.filter((r) => r.status === "HALF_DAY").length,
    leave: rows.filter((r) => r.status === "LEAVE").length,
    holiday: rows.filter((r) => r.status === "HOLIDAY").length,
    unmarked: rows.filter((r) => r.status === "UNMARKED").length,
    incomplete: rows.filter((r) => r.isIncomplete).length,
    overtime: rows.filter((r) => r.isOvertime).length,
    otAmount: rows.reduce((sum, r) => sum + (r.otAmount || 0), 0),
    totalHours:
      Math.round(rows.reduce((sum, r) => sum + r.totalHours, 0) * 10) / 10,
  };
}
export async function attendanceRows(
  req: Express.Request,
  query: Record<string, unknown>,
): Promise<AttendanceRow[]> {
  const company = await context();
  const { start, end } = dateRange(
    query.from,
    query.to,
    today(company.timezone),
  );
  const employeeId = objectId.optional().parse(query.employeeId);
  const department = z.string().max(120).optional().parse(query.department);
  const status = z
    .enum([...statuses, "UNMARKED", "INCOMPLETE"])
    .optional()
    .parse(query.status);
  const search = z.string().trim().max(100).optional().parse(query.search);
  const match = search ? new RegExp(escapeRegex(search), "i") : undefined;
  const filter = {
    $and: [
      await employeeScope(req),
      ...(employeeId ? [{ _id: employeeId }] : []),
      ...(department ? [{ department }] : []),
      ...(match
        ? [
            {
              $or: [
                { fullName: match },
                { employeeCode: match },
                { email: match },
                { department: match },
              ],
            },
          ]
        : []),
    ],
  };
  const employees = await Employee.find(filter)
    .sort({ fullName: 1, _id: 1 })
    .lean();
  const records = await Attendance.find({
    employeeId: { $in: employees.map((e) => e._id) },
    workDate: { $gte: start, $lte: end },
  })
    .sort({ workDate: -1, _id: 1 })
    .limit(20001)
    .lean();
  assert(
    records.length <= 20000,
    422,
    "REPORT_TOO_LARGE",
    "Narrow your filters to fewer than 20,000 records.",
  );
  const result: AttendanceRow[] = [];
  for (const emp of employees) {
    const ownRecords = records.filter(
      (r) => String(r.employeeId) === String(emp._id),
    );
    if (
      !ownRecords.length &&
      start === end &&
      emp.status === "ACTIVE" &&
      emp.joiningDate <= start
    ) {
      result.push({
        id: null,
        employeeId: String(emp._id),
        employeeName: emp.fullName,
        employeeCode: emp.employeeCode,
        email: emp.email,
        department: emp.department,
        designation: emp.designation,
        workDate: start,
        status: "UNMARKED",
        inTime: null,
        outTime: null,
        totalHours: 0,
        regularMinutes: 0,
        regularApproved: false,
        isIncomplete: false,
        isOvertime: false,
        version: 0,
        shiftStart: emp.shift?.startTime || "09:00",
        ...(canSeePay(req, emp.userId) ? { otAmount: 0, otRemark: "" } : {}),
      });
    }
    for (const row of ownRecords)
      result.push({
        id: String(row._id),
        employeeId: String(emp._id),
        employeeName: emp.fullName,
        employeeCode: emp.employeeCode,
        email: emp.email,
        department: emp.department,
        designation: emp.designation,
        workDate: row.workDate,
        status: row.status,
        inTime: row.inTime ?? null,
        outTime: row.outTime ?? null,
        totalHours: row.totalHours,
        regularMinutes: row.regularMinutes,
        regularApproved: row.regularApproved,
        isIncomplete: row.isIncomplete,
        isOvertime: row.isOvertime,
        version: row.version,
        shiftStart: emp.shift?.startTime || "09:00",
        ...(canSeePay(req, emp.userId)
          ? { otAmount: row.otAmount, otRemark: row.otRemark }
          : {}),
      });
  }
  return result
    .filter(
      (r) =>
        !status ||
        (status === "INCOMPLETE" ? r.isIncomplete : r.status === status),
    )
    .sort(
      (a, b) =>
        b.workDate.localeCompare(a.workDate) ||
        a.employeeName.localeCompare(b.employeeName),
    );
}
