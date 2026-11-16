import { DateTime } from "luxon";
import { z } from "zod";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { CompanyConfig, CronConfig } from "../modules/models.js";

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
export const token = () => randomBytes(32).toString("hex");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const equal = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const objectId = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, "Invalid record ID");
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => DateTime.fromISO(v).isValid, "Invalid date");
export const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine((v) => DateTime.fromISO(`${v}-01`).isValid, "Invalid month");
export const moneySchema = z.number().int().min(0).max(1e12);
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const pagination = (query: Record<string, unknown>) => ({
  page: z.coerce.number().int().min(1).default(1).parse(query.page),
  limit: z.coerce.number().int().min(1).max(100).default(20).parse(query.limit),
});
export async function context() {
  const [company, cron] = await Promise.all([
    CompanyConfig.findOne().lean(),
    CronConfig.findOne().lean(),
  ]);
  return {
    name: company?.name || "SME Attendance",
    currency: company?.currency || "INR",
    timezone: cron?.timezone || "Asia/Kolkata",
  };
}
export const today = (zone: string) =>
  DateTime.now().setZone(zone).toISODate()!;
export const escapeRegex = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function dateRange(from: unknown, to: unknown, fallback: string) {
  const start = dateSchema.parse(from || fallback),
    end = dateSchema.parse(to || start);
  const diff = DateTime.fromISO(end).diff(DateTime.fromISO(start), "days").days;
  assert(
    diff >= 0 && diff <= 365,
    422,
    "DATE_RANGE",
    "Choose an ordered date range of at most 366 days.",
  );
  return { start, end };
}
export function currency(value: number, code = "INR") {
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
  }).resolvedOptions().maximumFractionDigits;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: code,
  }).format(value / 10 ** (digits ?? 2));
}
