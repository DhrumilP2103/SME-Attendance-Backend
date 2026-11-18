import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { DateTime } from "luxon";
import {
  Attendance,
  Employee,
  AuditLog,
  IdempotencyRecord,
  statuses,
} from "../models.js";
import {
  requirePermission,
  scopedEmployee,
  employeeScope,
  canSeePay,
} from "../roles/permissions.js";
import {
  assert,
  objectId,
  dateSchema,
  moneySchema,
  pagination,
  dateRange,
  context,
  today,
} from "../../lib/core.js";
import { attendanceRows, summarize } from "./attendance.service.js";

export const attendanceRouter = Router();
attendanceRouter.get("/", async (req, res) => {
  const { page, limit } = pagination(req.query);
  const rows = await attendanceRows(req, req.query);
  res.json({
    data: rows.slice((page - 1) * limit, page * limit),
    meta: {
      page,
      limit,
      total: rows.length,
      summary: summarize(rows),
    },
  });
});
attendanceRouter.get(
  "/missing-hours",
  requirePermission("canMarkTeamAttendance"),
  async (req, res) => {
    const zone = (await context()).timezone;
    const { start, end } = dateRange(req.query.from, req.query.to, today(zone));
    const employees = await Employee.find({
      $and: [
        await employeeScope(req),
        { payType: "HOURLY", joiningDate: { $lte: end } },
      ],
    })
      .select("fullName employeeCode")
      .lean();
    const records = employees.length
      ? await Attendance.find({
          employeeId: { $in: employees.map((employee) => employee._id) },
          workDate: { $gte: start, $lte: end },
          status: "PRESENT",
          regularMinutes: { $lte: 0 },
        })
          .sort({ workDate: -1, _id: 1 })
          .limit(200)
          .lean()
      : [];
    const byId = new Map(employees.map((e) => [String(e._id), e]));
    const data = records.map((row) => ({
      employeeId: String(row.employeeId),
      employeeName: byId.get(String(row.employeeId))?.fullName || "Employee",
      employeeCode: byId.get(String(row.employeeId))?.employeeCode || "",
      workDate: row.workDate,
    }));
    res.json({ data: { count: data.length, rows: data } });
  },
);
for (const action of ["check-in", "check-out"] as const) {
  attendanceRouter.post(
    `/${action}`,
    requirePermission("canTakeSelfAttendance"),
    async (req, res) => {
      z.object({}).strict().parse(req.body);
      const key = z
        .string()
        .min(8)
        .max(100)
        .parse(req.headers["idempotency-key"]);
      const employee = await Employee.findOne({
        userId: req.auth!.user._id,
        status: "ACTIVE",
      });
      assert(
        employee,
        403,
        "NO_EMPLOYEE",
        "An active employee profile is required.",
      );
      const businessDate = today((await context()).timezone);
      assert(
        employee.joiningDate <= businessDate,
        422,
        "NOT_JOINED",
        "Your joining date has not arrived.",
      );
      const idempotencyKey = `${req.auth!.user._id}:${action}:${key}`;
      const data = await mongoose.connection.transaction(async (session) => {
        const cached = await IdempotencyRecord.findOne({
          key: idempotencyKey,
          expiresAt: { $gt: new Date() },
        }).session(session);
        if (cached) return cached.response;
        const now = new Date();
        const old = await Attendance.findOne({
          employeeId: employee._id,
          workDate: businessDate,
        }).session(session);
        let record;
        if (action === "check-in") {
          assert(
            !old,
            409,
            "ALREADY_MARKED",
            "Attendance already exists for today. Contact HR for corrections.",
          );
          assert(
            !(await Attendance.exists({
              employeeId: employee._id,
              inTime: { $ne: null },
              outTime: null,
            }).session(session)),
            409,
            "OPEN_PUNCH",
            "An earlier shift is still open. Ask HR to correct it first.",
          );
          [record] = await Attendance.create(
            [
              {
                employeeId: employee._id,
                workDate: businessDate,
                status: "PRESENT",
                inTime: now,
                markedBy: req.auth!.user._id,
              },
            ],
            { session },
          );
        } else {
          assert(
            old?.inTime && !old.outTime,
            409,
            "NO_OPEN_PUNCH",
            "There is no open check-in for today.",
          );
          record = await Attendance.findOneAndUpdate(
            { _id: old._id, outTime: null },
            {
              $set: {
                outTime: now,
                totalHours:
                  Math.round((now.getTime() - old.inTime.getTime()) / 36000) /
                  100,
                isIncomplete: false,
              },
              $inc: { version: 1 },
            },
            { new: true, session },
          );
          assert(
            record,
            409,
            "ALREADY_CHECKED_OUT",
            "You have already checked out.",
          );
        }
        await AuditLog.create(
          [
            {
              actorId: req.auth!.user._id,
              action: action.toUpperCase(),
              entityId: String(record._id),
              before: old?.toObject(),
              after: record.toObject(),
            },
          ],
          { session },
        );
        const response = {
          workDate: businessDate,
          status: record.status,
          inTime: record.inTime,
          outTime: record.outTime,
          totalHours: record.totalHours,
        };
        await IdempotencyRecord.create(
          [
            {
              key: idempotencyKey,
              response,
              expiresAt: new Date(Date.now() + 86400000),
            },
          ],
          { session },
        );
        return response;
      });
      res.json({ data });
    },
  );
}
const registerSchema = z
  .object({
    status: z.enum(statuses),
    inTime: z.string().datetime().nullable().optional(),
    outTime: z.string().datetime().nullable().optional(),
    regularMinutes: z.number().int().min(0).max(1440).optional(),
    isOvertime: z.boolean().optional(),
    otAmount: moneySchema.optional(),
    otRemark: z.string().trim().max(1000).optional(),
    modificationReason: z.string().trim().max(1000).optional(),
    version: z.number().int().min(0),
  })
  .strict();
attendanceRouter.put(
  "/:employeeId/:workDate",
  requirePermission("canMarkTeamAttendance"),
  async (req, res) => {
    const employee = await scopedEmployee(
      req,
      objectId.parse(req.params.employeeId),
      true,
    );
    const workDate = dateSchema.parse(req.params.workDate),
      body = registerSchema.parse(req.body);
    const zone = (await context()).timezone;
    assert(
      workDate <= today(zone) && workDate >= employee.joiningDate,
      422,
      "WORK_DATE",
      "Use a date between joining and today.",
    );
    assert(
      employee.status === "ACTIVE",
      422,
      "INACTIVE_EMPLOYEE",
      "Reactivate this employee before changing attendance.",
    );
    const otSupplied = ["isOvertime", "otAmount", "otRemark"].some(
      (k) => k in body,
    );
    assert(
      !otSupplied || req.auth!.permissions.canToggleOT,
      403,
      "OT_FORBIDDEN",
      "You cannot modify overtime.",
    );
    assert(
      body.regularMinutes === undefined ||
        req.auth!.user.role === "ADMIN" ||
        req.auth!.user.role === "HR",
      403,
      "PAY_FORBIDDEN",
      "Only HR/Admin can approve regular time.",
    );
    const updated = await mongoose.connection.transaction(async (session) => {
      const old = await Attendance.findOne({
        employeeId: employee._id,
        workDate,
      }).session(session);
      assert(
        (old?.version || 0) === body.version,
        409,
        "EDIT_CONFLICT",
        "Attendance was changed by someone else. Reload and try again.",
      );
      assert(
        !old || body.modificationReason,
        422,
        "REASON_REQUIRED",
        "Explain why this attendance is being changed.",
      );
      const inTime =
        body.inTime === undefined
          ? old?.inTime || null
          : body.inTime
            ? new Date(body.inTime)
            : null;
      const outTime =
        body.outTime === undefined
          ? old?.outTime || null
          : body.outTime
            ? new Date(body.outTime)
            : null;
      assert(
        !outTime || (inTime && outTime >= inTime),
        422,
        "PUNCH_ORDER",
        "Check-out must follow check-in.",
      );
      assert(
        !inTime ||
          (inTime <= new Date() &&
            DateTime.fromJSDate(inTime).setZone(zone).toISODate() === workDate),
        422,
        "PUNCH_DATE",
        "Check-in must match this business date and cannot be in the future.",
      );
      assert(
        !outTime || outTime <= new Date(),
        422,
        "PUNCH_DATE",
        "Check-out cannot be in the future.",
      );
      const totalMinutes =
        inTime && outTime
          ? Math.round((outTime.getTime() - inTime.getTime()) / 60000)
          : 0;
      assert(
        totalMinutes <= 1440,
        422,
        "SHIFT_TOO_LONG",
        "A shift cannot exceed 24 hours.",
      );
      const working = ["PRESENT", "HALF_DAY"].includes(body.status);
      assert(
        working || (!inTime && !outTime && !(body.regularMinutes || 0)),
        422,
        "STATUS_PUNCHES",
        "Clear punches and regular hours before marking a non-working status.",
      );
      const isOvertime = body.isOvertime ?? old?.isOvertime ?? false;
      const otAmount = isOvertime ? (body.otAmount ?? old?.otAmount ?? 0) : 0;
      const otRemark = isOvertime ? (body.otRemark ?? old?.otRemark ?? "") : "";
      assert(
        !isOvertime || (working && otAmount > 0 && otRemark.trim()),
        422,
        "INVALID_OT",
        "Overtime requires a working status, positive amount, and a remark.",
      );
      const regularMinutes = body.regularMinutes ?? old?.regularMinutes ?? 0;
      const standardMinutes = (employee.shift?.standardDailyHours || 8) * 60;
      assert(
        regularMinutes === 0 ||
          (regularMinutes <= standardMinutes &&
            (employee.payType === "HOURLY" ||
              (inTime && outTime && regularMinutes <= totalMinutes))),
        422,
        "REGULAR_HOURS",
        "Approved regular time must fit the standard shift and completed punches.",
      );
      const value = {
        status: body.status,
        inTime,
        outTime,
        totalHours: totalMinutes / 60,
        regularMinutes,
        regularApproved:
          body.regularMinutes !== undefined || old?.regularApproved || false,
        isOvertime,
        otAmount,
        otRemark,
        // Approved hours complete an hourly day even when the checkout punch is missing.
        isIncomplete:
          Boolean(inTime && !outTime) &&
          !(employee.payType === "HOURLY" && regularMinutes > 0),
        modificationReason: body.modificationReason || "",
        lastModifiedBy: req.auth!.user._id,
        ...(body.regularMinutes !== undefined || otSupplied
          ? { approvedBy: req.auth!.user._id }
          : {}),
      };
      let record;
      if (old)
        record = await Attendance.findOneAndUpdate(
          { _id: old._id, version: body.version },
          { $set: value, $inc: { version: 1 } },
          { new: true, session },
        );
      else
        [record] = await Attendance.create(
          [
            {
              ...value,
              employeeId: employee._id,
              workDate,
              markedBy: req.auth!.user._id,
            },
          ],
          { session },
        );
      assert(record, 409, "EDIT_CONFLICT", "Reload attendance and try again.");
      await AuditLog.create(
        [
          {
            actorId: req.auth!.user._id,
            action: "ATTENDANCE_EDITED",
            entityId: String(record._id),
            before: old?.toObject(),
            after: record.toObject(),
            reason: body.modificationReason,
          },
        ],
        { session },
      );
      return { id: record._id, version: record.version };
    });
    res.json({ data: updated });
  },
);
attendanceRouter.get(
  "/:employeeId/:workDate/audit",
  requirePermission("canMarkTeamAttendance"),
  async (req, res) => {
    const employee = await scopedEmployee(
      req,
      objectId.parse(req.params.employeeId),
      true,
    );
    assert(
      canSeePay(req, employee.userId),
      403,
      "FORBIDDEN",
      "Salary access is required for detailed audit values.",
    );
    const record = await Attendance.findOne({
      employeeId: employee._id,
      workDate: dateSchema.parse(req.params.workDate),
    });
    const data = record
      ? await AuditLog.find({ entityId: String(record._id) })
          .populate("actorId", "name")
          .sort({ createdAt: -1 })
          .limit(100)
          .lean()
      : [];
    res.json({ data });
  },
);
