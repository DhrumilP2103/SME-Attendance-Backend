import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  MONGODB_URI: z.string().default(""),
  ACCESS_TOKEN_ENCRYPTION_KEY: z.string().default(""),
  OUTBOX_ENCRYPTION_KEY: z.string().default(""),
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  MAIL_FROM: z.string().default(""),
});
export const env = schema.parse(process.env);
export const production = env.NODE_ENV === "production";
export const localDir = resolve(".local");
if (
  production &&
  (!env.MONGODB_URI ||
    !env.SMTP_HOST ||
    !env.MAIL_FROM ||
    env.DEMO_MODE === "true")
) {
  throw new Error(
    "Production requires MongoDB and SMTP configuration; demo mode must be disabled.",
  );
}
if (!production) {
  mkdirSync(localDir, { recursive: true, mode: 0o700 });
  const path = resolve(localDir, "keys.json");
  if (!existsSync(path))
    writeFileSync(
      path,
      JSON.stringify({
        access: randomBytes(32).toString("hex"),
        outbox: randomBytes(32).toString("hex"),
      }),
      { mode: 0o600 },
    );
  const keys = JSON.parse(readFileSync(path, "utf8"));
  env.ACCESS_TOKEN_ENCRYPTION_KEY ||= keys.access;
  env.OUTBOX_ENCRYPTION_KEY ||= keys.outbox;
}
for (const key of [
  env.ACCESS_TOKEN_ENCRYPTION_KEY,
  env.OUTBOX_ENCRYPTION_KEY,
]) {
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error(
      "Encryption keys must each contain 64 hexadecimal characters.",
    );
}
export const accessKey = Buffer.from(env.ACCESS_TOKEN_ENCRYPTION_KEY, "hex");
export const outboxKey = Buffer.from(env.OUTBOX_ENCRYPTION_KEY, "hex");
export const localDemo =
  !production && env.NODE_ENV !== "test" && env.DEMO_MODE === "true";
export const allowedOrigins = new Set([
  env.FRONTEND_ORIGIN,
  ...(!production ? ["http://localhost:3000", "http://127.0.0.1:3000"] : []),
]);
