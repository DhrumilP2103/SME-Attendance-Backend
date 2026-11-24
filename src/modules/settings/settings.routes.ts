import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { DateTime } from "luxon";
import {
  CompanyConfig,
  CronConfig,
  EodRun,
  Employee,
  AuditLog,
} from "../models.js";
import { adminOnly } from "../roles/permissions.js";
import {
  assert,
  context,
  timeSchema,
  dateSchema,
  today,
  pagination,
} from "../../lib/core.js";
import { smtpConfigured } from "../../lib/email.js";
import { logCreateActivity } from "../../lib/create-activity-log.js";

export const settingsRouter = Router();
settingsRouter.get("/settings/company", async (_req, res) =>
  res.json({ data: await context() }),
);
settingsRouter.patch("/settings/company", adminOnly, async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(120),
      currency: z.enum(["INR", "USD", "EUR", "GBP", "AED", "JPY"]),
    })
    .strict()
    .parse(req.body);
  const data = await mongoose.connection.transaction(async (session) => {
    const old = await CompanyConfig.findOne().session(session);
    if (old?.currency !== body.currency)
      assert(
        !(await Employee.exists({}).session(session)),
        409,
        "CURRENCY_LOCKED",
        "Currency cannot be changed after employee pay records exist.",
      );
    const company = await CompanyConfig.findOneAndUpdate(
      { key: "company" },
      body,
      { new: true, upsert: true, session },
    );
    await AuditLog.create(
      [
        {
          actorId: req.auth!.user._id,
          entityId: "company",
          action: "COMPANY_SETTINGS",
          before: old?.toObject(),
          after: body,
        },
      ],
      { session },
    );
    return company;
  });
  res.json({ data });
});
settingsRouter.get("/settings/eod", adminOnly, async (_req, res) => {
  const config = await CronConfig.findOne().lean();
  res.json({
    data: {
      ...config,
      sections: {
        attendance: config?.sections?.attendance ?? true,
        salary: Boolean(config?.sections?.salary),
      },
      activityLogEmail: {
        enabled: Boolean(config?.activityLogEmail?.enabled),
        intervalMonths: config?.activityLogEmail?.intervalMonths ?? 2,
        lastSentAt: config?.activityLogEmail?.lastSentAt,
        nextAttemptAt: config?.activityLogEmail?.nextAttemptAt,
      },
      emailDelivery: smtpConfigured ? "SMTP" : "LOCAL_OUTBOX",
    },
  });
});
settingsRouter.patch("/settings/eod", adminOnly, async (req, res) => {
  const parsed = z
    .object({
      isEnabled: z.boolean(),
      scheduledTime: timeSchema,
      timezone: z
        .string()
        .max(80)
        .refine(
          (s) => DateTime.now().setZone(s).isValid,
          "Choose a valid timezone.",
        ),
      adminRecipients: z.array(z.string().email()).min(1).max(20),
      sections: z
        .object({
          attendance: z.boolean(),
          salary: z.boolean(),
        })
        .strict(),
      activityLogEmail: z
        .object({
          enabled: z.boolean(),
          intervalMonths: z.number().int().min(1).max(12),
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(req.body);
  const { activityLogEmail, ...body } = parsed;
  const data = await mongoose.connection.transaction(async (session) => {
    const old = await CronConfig.findOne().session(session);
    const current = old?.activityLogEmail;
    const wasEnabled = Boolean(current?.enabled);
    const enabled = activityLogEmail?.enabled ?? wasEnabled;
    const intervalMonths = activityLogEmail?.intervalMonths ?? current?.intervalMonths ?? 2;
    let nextAttemptAt = current?.nextAttemptAt;
    if (!enabled) nextAttemptAt = undefined;
    else if (
      !wasEnabled ||
      intervalMonths !== (current?.intervalMonths ?? 2) ||
      !nextAttemptAt
    )
      nextAttemptAt =
        !wasEnabled || !current?.lastSentAt
          ? DateTime.now().plus({ months: intervalMonths }).toJSDate()
          : DateTime.fromJSDate(current.lastSentAt)
              .plus({ months: intervalMonths })
              .toJSDate();
    const update = {
      ...body,
      ...(activityLogEmail
        ? {
            activityLogEmail: {
              enabled,
              intervalMonths,
              ...(current?.lastSentAt
                ? { lastSentAt: current.lastSentAt }
                : {}),
              ...(nextAttemptAt ? { nextAttemptAt } : {}),
            },
          }
        : {}),
      updatedBy: req.auth!.user._id,
    };
    const result = await CronConfig.findOneAndUpdate(
      { taskName: "EOD_ATTENDANCE_REPORT" },
      update,
      { new: true, upsert: true, session },
    );
    await AuditLog.create(
      [
        {
          actorId: req.auth!.user._id,
          entityId: "eod-settings",
          action: "EOD_SETTINGS",
          before: old?.toObject(),
          after: parsed,
        },
      ],
      { session },
    );
    return result;
  });
  res.json({ data });
});
settingsRouter.post("/eod/send", adminOnly, async (req, res) => {
  const body = z
    .object({ workDate: dateSchema.optional() })
    .strict()
    .parse(req.body);
  const key = z.string().min(8).max(100).parse(req.headers["idempotency-key"]);
  const config = await CronConfig.findOne();
  assert(
    config?.adminRecipients.length,
    422,
    "NO_RECIPIENTS",
    "Save at least one report recipient first.",
  );
  const workDate = body.workDate || today(config.timezone);
  assert(
    workDate <= today(config.timezone),
    422,
    "FUTURE_DATE",
    "Reports cannot be sent for a future date.",
  );
  const runKey = `manual:${req.auth!.user._id}:${key}`;
  const run = await EodRun.findOneAndUpdate(
    { runKey },
    {
      $setOnInsert: {
        workDate,
        trigger: "MANUAL",
        requestedBy: req.auth!.user._id,
      },
    },
    { upsert: true, new: true },
  );
  assert(
    run!.workDate === workDate,
    409,
    "IDEMPOTENCY_CONFLICT",
    "This request key was already used for a different date.",
  );
  logCreateActivity(
    req.auth!.user,
    "EOD_REPORT_QUEUED",
    { type: "eod_run", id: run!._id, workDate },
    req,
  );
  res.status(202).json({ data: { runId: run!._id, status: run!.status } });
});
settingsRouter.get("/eod/runs", adminOnly, async (req, res) => {
  const { page, limit } = pagination(req.query);
  res.json({
    data: await EodRun.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    meta: { page, limit, total: await EodRun.countDocuments() },
  });
});
