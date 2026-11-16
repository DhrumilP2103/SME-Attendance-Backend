import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Employee, User, Counter, AuditLog } from "../models.js";
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
    department: text,
    designation: text,
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
async function checkCustomer(id?: string | null) {
  if (id)
    assert(
      await User.exists({ _id: id, role: "CUSTOMER", isActive: true }),
      422,
      "CUSTOMER",
      "Choose an active customer account.",
    );
}
employeesRouter.get("/", async (req, res) => {
  const { page, limit } = pagination(req.query);
  const search = z.string().max(100).optional().parse(req.query.search);
  const status = z
    .enum(["ACTIVE", "INACTIVE"])
    .optional()
    .parse(req.query.status);
  const department = z.string().max(120).optional().parse(req.query.department);
  const filter = {
    ...(status ? { status } : {}),
    ...(department ? { department } : {}),
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
  const [data, total, departments] = await Promise.all([
    Employee.find(filter)
      .select(select)
      .sort({ fullName: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Employee.countDocuments(filter),
    Employee.distinct("department"),
  ]);
  res.json({ data, meta: { page, limit, total, departments } });
});
employeesRouter.get("/customers", async (_req, res) => {
  const data = await User.find({ role: "CUSTOMER", isActive: true })
    .select("_id name")
    .sort({ name: 1 })
    .lean();
  res.json({ data });
});
employeesRouter.post(
  "/",
  requirePermission("canViewSalaryImpact"),
  async (req, res) => {
    const body = profile
      .extend({ userId: objectId.optional() })
      .parse(req.body);
    payCheck(body);
    await checkCustomer(body.assignedClientOrCustomer);
    const result = await mongoose.connection.transaction(async (session) => {
      let user = await User.findOne({ email: body.email }).session(session);
      if (user) {
        assert(
          user.role === "EMPLOYEE" &&
            user.isActive &&
            (!body.userId || String(user._id) === body.userId),
          422,
          "ACCOUNT_LINK",
          "Only a matching active Employee account can be linked.",
        );
        assert(
          !(await Employee.exists({ userId: user._id }).session(session)),
          409,
          "ACCOUNT_LINK",
          "This account already has an employee profile.",
        );
        user.name = body.fullName;
        await user.save({ session });
      } else {
        assert(
          !body.userId,
          422,
          "ACCOUNT_LINK",
          "No matching account was found.",
        );
        [user] = await User.create(
          [{ name: body.fullName, email: body.email, role: "EMPLOYEE" }],
          { session },
        );
      }
      const counter = await Counter.findOneAndUpdate(
        { key: "employee" },
        { $inc: { value: 1 } },
        { new: true, session, upsert: true },
      );
      const [employee] = await Employee.create(
        [{ ...body, userId: user._id, employeeCode: `EMP-${counter!.value}` }],
        { session },
      );
      const invitation = user.activated
        ? null
        : await queueAccountEmail(user, "INVITE", session);
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
  await checkCustomer(body.assignedClientOrCustomer);
  const result = await mongoose.connection.transaction(async (session) => {
    const old = await Employee.findById(id).session(session);
    assert(old, 404, "NOT_FOUND", "Employee not found.");
    payCheck({ ...old.toObject(), ...body });
    const { version, ...changes } = body;
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
    if (body.fullName)
      await User.updateOne(
        { _id: old.userId },
        { name: body.fullName },
        { session },
      );
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
