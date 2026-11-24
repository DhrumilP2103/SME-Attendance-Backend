import cron from "node-cron";
import { DateTime } from "luxon";
import {
  CronConfig,
  EodRun,
  User,
  Attendance,
  Employee,
  AuditLog,
} from "../modules/models.js";
import {
  attendanceRows,
  summarize,
} from "../modules/attendance/attendance.service.js";
import { defaults } from "../modules/roles/permissions.js";
import { context, currency, escapeHtml, today } from "../lib/core.js";
import { csv, reportTable } from "../modules/reports/reports.routes.js";
import { calculatePayroll } from "../modules/payroll/payroll.service.js";
import { sendMail, processOutbox } from "../lib/email.js";
import { takeCreateActivityLog } from "../lib/create-activity-log.js";
import mongoose from "mongoose";

type CronConfigForActivityLog = {
  _id: mongoose.Types.ObjectId;
  adminRecipients: string[];
  activityLogEmail?: {
    enabled?: boolean;
    intervalMonths?: number;
    lastSentAt?: Date | null;
    nextAttemptAt?: Date | null;
  } | null;
};

async function deliverActivityLog(config: CronConfigForActivityLog) {
  const settings = config.activityLogEmail;
  if (!settings?.enabled || !config.adminRecipients.length) return;
  if (settings.nextAttemptAt && settings.nextAttemptAt.getTime() > Date.now())
    return;

  const now = new Date();
  const intervalMonths = Math.min(
    12,
    Math.max(1, Math.round(settings.intervalMonths ?? 2)),
  );
  const nextDelivery = () =>
    DateTime.fromJSDate(now).plus({ months: intervalMonths }).toJSDate();
  await CronConfig.updateOne(
    { _id: config._id },
    {
      $set: {
        "activityLogEmail.nextAttemptAt": new Date(
          now.getTime() + 60 * 60 * 1000,
        ),
      },
    },
  );

  const claim = await takeCreateActivityLog();
  if (!claim) {
    await CronConfig.updateOne(
      { _id: config._id },
      { $set: { "activityLogEmail.nextAttemptAt": nextDelivery() } },
    );
    return;
  }

  const entries = claim.content.split("\n").filter((line) => {
    if (!line.trim()) return false;
    try {
      return typeof JSON.parse(line).action === "string";
    } catch {
      return false;
    }
  });
  if (!entries.length) {
    await claim.commit();
    await CronConfig.updateOne(
      { _id: config._id },
      { $set: { "activityLogEmail.nextAttemptAt": nextDelivery() } },
    );
    return;
  }

  try {
    const company = await context();
    await sendMail(
      config.adminRecipients,
      `Create activity log · ${entries.length} entries · ${company.name}`,
      `<div style="font:14px Arial;max-width:680px;margin:30px auto;color:#203c33"><h1>${escapeHtml(company.name)}</h1><h2>Create activity log</h2><p>${entries.length} create activity ${entries.length === 1 ? "entry is" : "entries are"} attached for the current delivery period. The log is cleared after the email is accepted by the mail service.</p><p style="color:#7b8781">Prepared ${escapeHtml(now.toISOString())} · ${escapeHtml(company.timezone)}</p></div>`,
      [
        {
          filename: `create-activity-${now.toISOString().slice(0, 10)}.log`,
          content: claim.content,
        },
      ],
    );
  } catch (error) {
    await claim.rollback().catch(() => {
      console.error("Activity log rollback failed after delivery failure.");
    });
    await CronConfig.updateOne(
      { _id: config._id },
      {
        $set: {
          "activityLogEmail.nextAttemptAt": new Date(
            Date.now() + 60 * 60 * 1000,
          ),
        },
      },
    );
    console.error("Activity log delivery failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return;
  }
  await claim.commit().catch(() => {
    console.error("Activity log was delivered but its file could not be cleared.");
  });
  await CronConfig.updateOne(
    { _id: config._id },
    {
      $set: {
        "activityLogEmail.lastSentAt": now,
        "activityLogEmail.nextAttemptAt": nextDelivery(),
      },
    },
  );
}

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
    try {
      await deliverActivityLog(config);
    } catch {
      console.error(
        "Activity log delivery cycle failed; retrying on a later cycle.",
      );
    }
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
      const company = await context(),
        month = run.workDate.slice(0, 7);
      const sections = {
        attendance: config.sections?.attendance ?? true,
        salary: Boolean(config.sections?.salary),
      };
      const rows = await attendanceRows(request, {
          from: run.workDate,
          to: run.workDate,
        }),
        summary = summarize(rows);
      const statusText = (status: string) =>
        status === "HALF_DAY"
          ? "Half day"
          : status.charAt(0) + status.slice(1).toLowerCase();
      const table = (head: string[], body: string[][]) =>
        `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px"><tr>${head
          .map(
            (h) =>
              `<th align="left" style="padding:8px;border-bottom:2px solid #17664e;font-size:11px;text-transform:uppercase;color:#56706a">${escapeHtml(h)}</th>`,
          )
          .join("")}</tr>${body
          .map(
            (cells) =>
              `<tr>${cells.map((c) => `<td style="padding:8px;border-bottom:1px solid #e4ebe7">${c}</td>`).join("")}</tr>`,
          )
          .join("") || `<tr><td colspan="${head.length}" style="padding:12px;color:#7b8781">No entries</td></tr>`}</table>`;
      const attendanceHtml = sections.attendance
        ? `<h2>Attendance report</h2><p style="color:#56706a">${summary.present} present · ${summary.absent} absent · ${summary.unmarked} unmarked · ${summary.incomplete} incomplete · OT ${escapeHtml(currency(summary.otAmount, company.currency))}</p>${table(
            ["Employee", "Status", "Hours", "Overtime"],
            rows.map((r) => [
              `${escapeHtml(r.employeeName)} <span style="color:#7b8781">${escapeHtml(r.employeeCode)}</span>`,
              escapeHtml(statusText(r.status)),
              r.totalHours.toFixed(1),
              r.isOvertime
                ? `${escapeHtml(currency(r.otAmount || 0, company.currency))} — ${escapeHtml(r.otRemark)}`
                : "—",
            ]),
          )}`
        : "";
      let salaryRows: {
        name: string;
        code: string;
        pay: ReturnType<typeof calculatePayroll>;
      }[] = [];
      if (sections.salary) {
        const employees = await Employee.find({ status: "ACTIVE" })
          .sort({ fullName: 1 })
          .lean();
        const records = await Attendance.find({
          employeeId: { $in: employees.map((e) => e._id) },
          workDate: { $gte: `${month}-01`, $lte: `${month}-31` },
        }).lean();
        salaryRows = employees.map((employee) => ({
          name: employee.fullName,
          code: employee.employeeCode,
          pay: calculatePayroll(
            employee,
            records.filter(
              (r) => String(r.employeeId) === String(employee._id),
            ),
            month,
            today(config.timezone),
          ),
        }));
      }
      const salaryHtml = sections.salary
        ? `<h2>Salary report · ${month} <span style="font-size:11px;color:#8a6d3b;font-weight:400">(estimate)</span></h2><p style="color:#7b8781">Paid-leave, half-day and prorating policies still need business approval.</p>${table(
            ["Employee", "Base", "Deductions", "Overtime", "Net (estimate)"],
            salaryRows.map(({ name, code, pay }) => [
              `${escapeHtml(name)} <span style="color:#7b8781">${escapeHtml(code)}</span>`,
              escapeHtml(currency(pay.basePay, company.currency)),
              `−${escapeHtml(currency(pay.deductions, company.currency))}`,
              `+${escapeHtml(currency(pay.approvedOt, company.currency))}`,
              `<strong>${escapeHtml(currency(pay.netPayable, company.currency))}</strong>`,
            ]),
          )}`
        : "";
      const html = `<div style="font:14px Arial;max-width:760px;margin:30px auto;color:#203c33"><h1>${escapeHtml(company.name)}</h1><p style="color:#7b8781">Daily report · ${run.workDate} · ${escapeHtml(company.timezone)}</p>${attendanceHtml}${salaryHtml}</div>`;
      if (
        leaseLost ||
        !(await EodRun.exists({
          _id: run._id,
          status: "RUNNING",
          leaseUntil: { $gt: new Date() },
        }))
      )
        throw new Error("Report lease expired before delivery.");
      const attachments: { filename: string; content: string }[] = [];
      if (sections.attendance)
        attachments.push({
          filename: `Daily_Attendance_EOD_${run.workDate}.csv`,
          content: csv(reportTable(rows, company.currency)),
        });
      if (sections.salary)
        attachments.push({
          filename: `Salary_Estimate_${month}.csv`,
          content: csv([
            [
              "Employee",
              "Code",
              "Base pay",
              "Deductions",
              "Approved OT",
              "Net (estimate)",
              "Currency",
            ],
            ...salaryRows.map(({ name, code, pay }) => [
              name,
              code,
              (pay.basePay / 100).toFixed(2),
              (pay.deductions / 100).toFixed(2),
              (pay.approvedOt / 100).toFixed(2),
              (pay.netPayable / 100).toFixed(2),
              company.currency,
            ]),
          ]),
        });
      const result = await sendMail(
        config.adminRecipients,
        `[EOD Report] - ${company.name} - ${run.workDate}${sections.attendance ? ` (Present: ${summary.present} | Absent: ${summary.absent} | OT: ${currency(summary.otAmount, company.currency)})` : ""}`,
        html,
        attachments,
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
