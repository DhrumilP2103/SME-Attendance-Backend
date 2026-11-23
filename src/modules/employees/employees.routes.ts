import { Router } from "express";
import mongoose from "mongoose";
import argon2 from "argon2";
import { z } from "zod";
import {
  Employee,
  User,
  Counter,
  AuditLog,
  Attendance,
  Session,
  AccountToken,
  EmailOutbox,
} from "../models.js";
import { requirePermission, canSeePay } from "../roles/permissions.js";
import {
  assert,
  dateSchema,
  moneySchema,
  timeSchema,
  objectId,
  pagination,
  escapeRegex,
} from "../../lib/core.js";
import { queueAccountEmail } from "../../lib/email.js";

export const employeesRouter = Router();
employeesRouter.use(requirePermission("canManageEmployees"));
const text = z.string().trim().min(1).max(120);
const profile = z
  .object({
    fullName: text,
    email: z.string().email().toLowerCase(),
    phone: z.string().max(30).default(""),
    joiningDate: dateSchema,
    payType: z.enum(["SALARIED", "HOURLY"]),
    baseSalary: moneySchema.default(0),
    hourlyRate: moneySchema.default(0),
    salaryDivisorPolicy: z
      .enum(["FIXED_26", "FIXED_30", "CALENDAR"])
      .default("FIXED_30"),
    shift: z
      .object({
        startTime: timeSchema,
        endTime: timeSchema,
        graceMinutes: z.number().int().min(0).max(120),
        standardDailyHours: z.number().min(1).max(16),
      })
      .strict(),
    weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(6).default([0]),
    assignedClientOrCustomer: objectId.nullable().optional(),
    profilePhotoUrl: z
      .union([
        z.literal(""),
        z
          .string()
          .url()
          .refine((s) => s.startsWith("https://"), "Use an HTTPS image URL"),
      ])
      .default(""),
  })
  .strict();
function payCheck(body: {
  payType?: string;
  baseSalary?: number;
  hourlyRate?: number;
}) {
  assert(
    body.payType !== "SALARIED" || (body.baseSalary || 0) > 0,
    422,
    "PAY_RATE",
    "Enter a positive monthly salary.",
  );
  assert(
    body.payType !== "HOURLY" || (body.hourlyRate || 0) > 0,
    422,
    "PAY_RATE",
    "Enter a positive hourly rate.",
  );
}
employeesRouter.get("/", async (req, res) => {
  const { page, limit } = pagination(req.query);
  const search = z.string().max(100).optional().parse(req.query.search);
  const status = z
    .enum(["ACTIVE", "INACTIVE"])
    .optional()
    .parse(req.query.status);
  const accountRole = z
    .enum(["HR", "EMPLOYEE"])
    .optional()
    .parse(req.query.accountRole);
  const adminIds = await User.find({ role: "ADMIN" }).distinct("_id");
  const roleUserIds = accountRole
    ? await User.find({ role: accountRole }).distinct("_id")
    : null;
  const filter = {
    userId: {
      $nin: adminIds,
      ...(roleUserIds ? { $in: roleUserIds } : {}),
    },
    ...(status ? { status } : {}),
    ...(search
      ? {
          $or: [
            { fullName: new RegExp(escapeRegex(search), "i") },
            { employeeCode: new RegExp(escapeRegex(search), "i") },
            { email: new RegExp(escapeRegex(search), "i") },
          ],
        }
      : {}),
  };
  const select = canSeePay(req) ? "" : "-baseSalary -hourlyRate";
  const [data, total] = await Promise.all([
    Employee.find(filter)
      .select(select)
      .sort({ fullName: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Employee.countDocuments(filter),
  ]);
  const accounts = await User.find({
    _id: { $in: data.map((employee) => employee.userId) },
  })
    .select("role")
    .lean();
  const roleByUser = new Map(
    accounts.map((account) => [String(account._id), account.role]),
  );
  res.json({
    data: data.map((employee) => ({
      ...employee,
      accountRole: roleByUser.get(String(employee.userId)) ?? "EMPLOYEE",
    })),
    meta: { page, limit, total },
  });
});
employeesRouter.get("/customers", async (_req, res) => {
  res.json({ data: [] });
});
employeesRouter.post(
  "/",
  requirePermission("canViewSalaryImpact"),
  async (req, res) => {
    const body = profile
      .extend({
        email: profile.shape.email.optional().or(z.literal("")),
        baseSalary: profile.shape.baseSalary.removeDefault().optional(),
        hourlyRate: profile.shape.hourlyRate.removeDefault().optional(),
        role: z.enum(["EMPLOYEE", "HR"]).optional(),
        password: z
          .string()
          .min(6, "Use at least 6 characters.")
          .max(128)
          .optional(),
      })
      .parse(req.body);
    if (body.baseSalary !== undefined || body.hourlyRate !== undefined)
      payCheck(body);
    assert(
      body.role !== "HR" || req.auth!.user.role === "ADMIN",
      403,
      "FORBIDDEN",
      "Only Admin can create HR accounts.",
    );
    const email = (body.email || "").trim();
    assert(
      !body.password || email,
      422,
      "EMAIL_REQUIRED",
      "Add an email address so this account can sign in.",
    );
    const passwordHash = body.password
      ? await argon2.hash(body.password)
      : undefined;
    const result = await mongoose.connection.transaction(async (session) => {
      const counter = await Counter.findOneAndUpdate(
        { key: "employee" },
        { $inc: { value: 1 } },
        { new: true, session, upsert: true },
      );
      const accountEmail = email || `emp-${counter!.value}@no-email.invalid`;
      assert(
        !(await User.exists({ email: accountEmail }).session(session)),
        409,
        "ACCOUNT_EXISTS",
        "An account with this email already exists. Use a different email.",
      );
      const [user] = await User.create(
        [
          {
            name: body.fullName,
            email: accountEmail,
            role: body.role ?? "EMPLOYEE",
            ...(passwordHash ? { passwordHash, activated: true } : {}),
          },
        ],
        { session },
      );
      const record: Record<string, unknown> = { ...body, email };
      delete record.password;
      delete record.role;
      const [employee] = await Employee.create(
        [
          {
            ...record,
            userId: user._id,
            employeeCode: `EMP-${counter!.value}`,
          },
        ],
        { session },
      );
      const invitation =
        !user.activated && email
          ? await queueAccountEmail(user, "INVITE", session)
          : null;
      await AuditLog.create(
        [
          {
            actorId: req.auth!.user._id,
            action: "EMPLOYEE_CREATED",
            entityId: String(employee._id),
            after: employee.toObject(),
          },
        ],
        { session },
      );
      return { employee, invitation };
    });
    res.status(201).json({ data: result });
  },
);
employeesRouter.get("/:id", async (req, res) => {
  const data = await Employee.findById(objectId.parse(req.params.id))
    .select(canSeePay(req) ? "" : "-baseSalary -hourlyRate")
    .lean();
  assert(data, 404, "NOT_FOUND", "Employee not found.");
  res.json({ data });
});
employeesRouter.patch("/:id", async (req, res) => {
  const id = objectId.parse(req.params.id);
  const body = profile
    .omit({ email: true })
    .extend({
      email: profile.shape.email.optional(),
      phone: profile.shape.phone.removeDefault(),
      baseSalary: profile.shape.baseSalary.removeDefault(),
      hourlyRate: profile.shape.hourlyRate.removeDefault(),
      salaryDivisorPolicy: profile.shape.salaryDivisorPolicy.removeDefault(),
      weeklyOffDays: profile.shape.weeklyOffDays.removeDefault(),
      profilePhotoUrl: profile.shape.profilePhotoUrl.removeDefault(),
    })
    .partial()
    .extend({
      status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
      version: z.number().int().min(1),
    })
    .strict()
    .parse(req.body);
  if (
    ["baseSalary", "hourlyRate", "payType", "salaryDivisorPolicy"].some(
      (k) => k in body,
    )
  )
    assert(
      canSeePay(req),
      403,
      "FORBIDDEN",
      "Salary authorization is required.",
    );
  const result = await mongoose.connection.transaction(async (session) => {
    const old = await Employee.findById(id).session(session);
    assert(old, 404, "NOT_FOUND", "Employee not found.");
    if (body.baseSalary !== undefined || body.hourlyRate !== undefined)
      payCheck({ ...old.toObject(), ...body });
    const { version, ...changes } = body;
    if (changes.email && changes.email !== old.email)
      assert(
        !(await User.exists({
          email: changes.email,
          _id: { $ne: old.userId },
        }).session(session)),
        409,
        "ACCOUNT_EXISTS",
        "An account with this email already exists. Use a different email.",
      );
    const employee = await Employee.findOneAndUpdate(
      { _id: id, version },
      { $set: changes, $inc: { version: 1 } },
      { new: true, runValidators: true, session },
    );
    assert(
      employee,
      409,
      "EDIT_CONFLICT",
      "This record changed. Reload and try again.",
    );
    if (body.fullName || body.email)
      await User.updateOne(
        { _id: old.userId },
        {
          $set: {
            ...(body.fullName ? { name: body.fullName } : {}),
            ...(body.email ? { email: body.email } : {}),
          },
        },
        { session },
      );
    // A sign-in email added or changed on an unactivated account needs a fresh activation link.
    if (body.email && body.email !== old.email) {
      const account = await User.findById(old.userId).session(session);
      if (account?.isActive && !account.activated)
        await queueAccountEmail(account, "INVITE", session);
    }
    await AuditLog.create(
      [
        {
          actorId: req.auth!.user._id,
          action: "EMPLOYEE_UPDATED",
          entityId: id,
          before: old.toObject(),
          after: employee.toObject(),
        },
      ],
      { session },
    );
    return employee.toObject();
  });
  const output: Record<string, unknown> = { ...result };
  if (!canSeePay(req)) {
    delete output.baseSalary;
    delete output.hourlyRate;
  }
  res.json({ data: output });
});
employeesRouter.delete("/:id", async (req, res) => {
  const id = objectId.parse(req.params.id);
  const data = await mongoose.connection.transaction(async (session) => {
    const employee = await Employee.findById(id).session(session);
    assert(employee, 404, "NOT_FOUND", "Employee not found.");
    assert(
      String(employee.userId) !== String(req.auth!.user._id),
      422,
      "SELF_DELETE",
      "You cannot delete your own account.",
    );
    const account = await User.findById(employee.userId).session(session);
    assert(
      account?.role !== "ADMIN",
      422,
      "ADMIN_PROTECTED",
      "Admin accounts cannot be deleted from the employee directory.",
    );
    const attendance = await Attendance.find({ employeeId: employee._id })
      .select("_id")
      .session(session)
      .lean();
    await Attendance.deleteMany({ employeeId: employee._id }, { session });
    await Session.deleteMany({ userId: employee.userId }, { session });
    await AccountToken.deleteMany({ userId: employee.userId }, { session });
    if (account?.email)
      await EmailOutbox.deleteMany({ recipient: account.email }, { session });
    await Employee.deleteOne({ _id: employee._id }, { session });
    await User.deleteOne({ _id: employee.userId }, { session });
    await AuditLog.deleteMany(
      {
        entityId: {
          $in: [
            String(employee._id),
            String(employee.userId),
            ...attendance.map((row) => String(row._id)),
          ],
        },
      },
      { session },
    );
    await AuditLog.create(
      [
        {
          actorId: req.auth!.user._id,
          action: "EMPLOYEE_DELETED",
          entityId: String(employee._id),
          before: {
            employeeCode: employee.employeeCode,
            fullName: employee.fullName,
          },
        },
      ],
      { session },
    );
    return { id: String(employee._id), employeeCode: employee.employeeCode };
  });
  res.json({ data });
});
