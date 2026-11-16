import cron from "node-cron";
import { DateTime } from "luxon";
import {
  CronConfig,
  EodRun,
  User,
  Attendance,
  AuditLog,
} from "../modules/models.js";
import {
  attendanceRows,
  summarize,
} from "../modules/attendance/attendance.service.js";
import { defaults } from "../modules/roles/permissions.js";
import { context, currency, escapeHtml } from "../lib/core.js";
import { csv, reportTable } from "../modules/reports/reports.routes.js";
import { sendMail, processOutbox } from "../lib/email.js";
import mongoose from "mongoose";

async function markIncomplete(cutoffDate: string) {
  await mongoose.connection.transaction(async (session) => {
    const pending = await Attendance.find({
      workDate: { $lte: cutoffDate },
      inTime: { $ne: null },
      outTime: null,
      isIncomplete: false,
    })
      .limit(500)
      .session(session);
    for (const item of pending) {
      const before = item.toObject();
      item.isIncomplete = true;
      item.version += 1;
      await item.save({ session });
      await AuditLog.create(
        [
          {
            action: "EOD_INCOMPLETE",
            entityId: String(item._id),
            before,
            after: item.toObject(),
          },
        ],
        { session },
      );
    }
  });
}

let busy = false;
export async function tick() {
  if (busy) return;
  busy = true;
  try {
    await processOutbox();
    const config = await CronConfig.findOne();
    if (!config) return;
    const now = DateTime.now().setZone(config.timezone),
      date = now.toISODate()!;
    await markIncomplete(
      now.toFormat("HH:mm") >= config.scheduledTime
        ? date
        : now.minus({ days: 1 }).toISODate()!,
    );
    if (
      config.isEnabled &&
      config.adminRecipients.length &&
      now.toFormat("HH:mm") >= config.scheduledTime
    ) {
      await EodRun.updateOne(
        { runKey: `scheduled:${date}` },
        { $setOnInsert: { workDate: date, trigger: "SCHEDULED" } },
        { upsert: true },
      );
    }
    await EodRun.updateMany(
      { status: "RUNNING", leaseUntil: { $lt: new Date() } },
      {
        status: "FAILED",
        error:
          "Interrupted delivery. Verify receipt before sending a new manual run.",
      },
    );
    const run = await EodRun.findOneAndUpdate(
      { status: "PENDING" },
      {
        $set: {
          status: "RUNNING",
          leaseUntil: new Date(Date.now() + 5 * 60000),
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { createdAt: 1 } },
    );
    if (!run) return;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void EodRun.updateOne(
        { _id: run._id, status: "RUNNING", leaseUntil: { $gt: new Date() } },
        { leaseUntil: new Date(Date.now() + 5 * 60000) },
      )
        .then((result) => {
          if (!result.matchedCount) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        });
    }, 30000);
    heartbeat.unref();
    try {
      const admin = await User.findOne({
        role: "ADMIN",
        isActive: true,
      }).lean();
      if (!admin || !config.adminRecipients.length)
        throw new Error("No active Admin or recipients.");
      const request = {
        auth: { user: admin, permissions: defaults.ADMIN, sessionId: "worker" },
      } as Express.Request;
      const rows = await attendanceRows(request, {
        from: run.workDate,
        to: run.workDate,
      });
      const summary = summarize(rows),
        company = await context();
      const section = (title: string, selected: typeof rows) =>
        `<h2>${title}</h2><table style="width:100%;border-collapse:collapse">${selected.map((r) => `<tr><td style="padding:10px;border-bottom:1px solid #ddd">${escapeHtml(r.employeeName)}</td><td>${escapeHtml(r.department)}</td><td>${escapeHtml(r.status)}</td><td>${r.isOvertime ? `${escapeHtml(currency(r.otAmount || 0, company.currency))} — ${escapeHtml(r.otRemark)}` : ""}</td></tr>`).join("") || "<tr><td>No entries</td></tr>"}</table>`;
      const html = `<div style="font:14px Arial;max-width:760px;margin:30px auto;color:#203c33"><h1>${escapeHtml(company.name)}</h1><p>Attendance summary · ${run.workDate} · ${escapeHtml(company.timezone)}</p>${config.sections?.summary ? `<h2>${summary.present} present · ${summary.absent} absent · ${summary.unmarked} unmarked</h2><p>${summary.incomplete} incomplete · OT ${escapeHtml(currency(summary.otAmount, company.currency))}</p>` : ""}${
        config.sections?.absent
          ? section(
              "Absent & unmarked",
              rows.filter((r) =>
                ["ABSENT", "UNMARKED", "LEAVE"].includes(r.status),
              ),
            )
          : ""
      }${
        config.sections?.incomplete
          ? section(
              "Incomplete punches",
              rows.filter((r) => r.isIncomplete),
            )
          : ""
      }${
        config.sections?.overtime
          ? section(
              "Overtime",
              rows.filter((r) => r.isOvertime),
            )
          : ""
      }</div>`;
      if (
        leaseLost ||
        !(await EodRun.exists({
          _id: run._id,
          status: "RUNNING",
          leaseUntil: { $gt: new Date() },
        }))
      )
        throw new Error("Report lease expired before delivery.");
      const result = await sendMail(
        config.adminRecipients,
        `[EOD Attendance Report] - ${company.name} - ${run.workDate} (Present: ${summary.present} | Absent: ${summary.absent} | OT: ${currency(summary.otAmount, company.currency)})`,
        html,
        [
          {
            filename: `Daily_Attendance_EOD_${run.workDate}.csv`,
            content: csv(reportTable(rows, company.currency)),
          },
        ],
      );
      await EodRun.updateOne(
        { _id: run._id, status: "RUNNING" },
        { status: "SUCCESS", result, error: "" },
      );
      await CronConfig.updateOne(
        { _id: config._id },
        { lastRunAt: new Date(), lastStatus: "SUCCESS", lastErrorMessage: "" },
      );
    } catch {
      await EodRun.updateOne(
        { _id: run._id },
        {
          status: "FAILED",
          error:
            "Delivery failed or is uncertain. Check SMTP and verify receipt before sending again.",
        },
      );
      await CronConfig.updateOne(
        { _id: config._id },
        {
          lastRunAt: new Date(),
          lastStatus: "FAILED",
          lastErrorMessage: "Report delivery failed.",
        },
      );
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    busy = false;
  }
}
export function startScheduler() {
  const job = cron.schedule(
    "*/15 * * * * *",
    () =>
      tick().catch(() =>
        console.error("Worker cycle failed; retrying on next cycle."),
      ),
    { noOverlap: true },
  );
  void tick().catch(() => console.error("Initial worker cycle failed."));
  return job;
}
