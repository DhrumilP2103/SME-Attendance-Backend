import nodemailer from "nodemailer";
import { EncryptJWT, jwtDecrypt } from "jose";
import type { ClientSession, Types } from "mongoose";
import { AccountToken, EmailOutbox } from "../modules/models.js";
import { env, outboxKey, production, localDir } from "../config/env.js";
import { escapeHtml, hash, token } from "./core.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const smtpConfigured = Boolean(env.SMTP_HOST && env.MAIL_FROM);
const smtpTransport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE === "true",
  auth: env.SMTP_USER
    ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
    : undefined,
  connectionTimeout: 15000,
  socketTimeout: 30000,
});
const localTransport = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: "unix",
});

export async function sendMail(
  to: string[],
  subject: string,
  html: string,
  attachments: { filename: string; content: Buffer | string }[] = [],
) {
  if (!smtpConfigured && production) throw new Error("SMTP is not configured.");
  const message = {
    from: env.MAIL_FROM || "SME Attendance <local@sme.test>",
    to,
    subject,
    html,
    attachments,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (!smtpConfigured) {
    const result = await localTransport.sendMail(message);
    const dir = resolve(localDir, "mail");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(dir, `${Date.now()}-${token().slice(0, 8)}.eml`),
      result.message,
      { mode: 0o600 },
    );
    return "Saved to local mail outbox (not delivered)";
  }
  const result = await smtpTransport.sendMail(message);
  return `Accepted by SMTP: ${result.messageId}`;
}
export async function queueAccountEmail(
  user: { _id: Types.ObjectId; name: string; email: string },
  purpose: "INVITE" | "RESET",
  session?: ClientSession,
) {
  const raw = token(),
    seconds = purpose === "INVITE" ? 86400 : 1800;
  await AccountToken.updateMany(
    { userId: user._id, purpose, consumed: false },
    { consumed: true },
    { session },
  );
  await AccountToken.create(
    [
      {
        userId: user._id,
        purpose,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + seconds * 1000),
      },
    ],
    { session },
  );
  const href = `${env.FRONTEND_ORIGIN}/${purpose === "INVITE" ? "activate-account" : "reset-password"}#token=${raw}`;
  const title =
    purpose === "INVITE" ? "Welcome to your workspace" : "Reset your password";
  const html = `<div style="font:16px Arial;max-width:560px;margin:40px auto;color:#183b35"><h1>${title}</h1><p>Hello ${escapeHtml(user.name)},</p><p><a href="${escapeHtml(href)}">${purpose === "INVITE" ? "Activate your account" : "Choose a new password"}</a></p><p>This single-use link expires in ${purpose === "INVITE" ? "24 hours" : "30 minutes"}. If you did not request this, ignore this email.</p></div>`;
  const encryptedPayload = await new EncryptJWT({ subject: title, html })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setExpirationTime(`${seconds}s`)
    .encrypt(outboxKey);
  await EmailOutbox.create([{ recipient: user.email, encryptedPayload }], {
    session,
  });
  return { queued: true, delivery: smtpConfigured ? "SMTP" : "LOCAL_OUTBOX" };
}
export async function processOutbox() {
  await EmailOutbox.updateMany(
    { status: "RUNNING", updatedAt: { $lt: new Date(Date.now() - 5 * 60000) } },
    {
      status: "FAILED",
      encryptedPayload: "",
      error:
        "Delivery was interrupted. Resend the invitation or password reset.",
    },
  );
  for (let i = 0; i < 10; i++) {
    const item = await EmailOutbox.findOneAndUpdate(
      { status: "PENDING", nextAttemptAt: { $lte: new Date() } },
      { $set: { status: "RUNNING" }, $inc: { attempts: 1 } },
      { new: true },
    );
    if (!item) break;
    try {
      const { payload } = await jwtDecrypt(item.encryptedPayload, outboxKey, {
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      });
      await sendMail(
        [item.recipient],
        String(payload.subject),
        String(payload.html),
      );
      await EmailOutbox.updateOne(
        { _id: item._id },
        { status: "SENT", encryptedPayload: "", error: "" },
      );
    } catch {
      await EmailOutbox.updateOne(
        { _id: item._id },
        {
          status: item.attempts >= 3 ? "FAILED" : "PENDING",
          nextAttemptAt: new Date(Date.now() + item.attempts * 60000),
          error: "Email delivery failed; check SMTP configuration.",
          ...(item.attempts >= 3 ? { encryptedPayload: "" } : {}),
        },
      );
    }
  }
}
