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
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
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
  console.warn(
    "Warning: Production requires MONGODB_URI and SMTP configuration; please ensure they are set in Vercel Environment Variables.",
  );
}
if (!production) {
  try {
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
  } catch {}
}
if (
  !env.ACCESS_TOKEN_ENCRYPTION_KEY ||
  !/^[a-f0-9]{64}$/i.test(env.ACCESS_TOKEN_ENCRYPTION_KEY)
) {
  env.ACCESS_TOKEN_ENCRYPTION_KEY =
    "7be12efdee4ac5acc9090f52c8a502efeddcaea57e2e6711bd214c2b591e6bb0";
}
if (
  !env.OUTBOX_ENCRYPTION_KEY ||
  !/^[a-f0-9]{64}$/i.test(env.OUTBOX_ENCRYPTION_KEY)
) {
  env.OUTBOX_ENCRYPTION_KEY =
    "a5fab70816096c32f4812858c5cf6b3a6f4b551df1e4654cdcf593ba2eb69433";
}
export const accessKey = Buffer.from(env.ACCESS_TOKEN_ENCRYPTION_KEY, "hex");
export const outboxKey = Buffer.from(env.OUTBOX_ENCRYPTION_KEY, "hex");
export const localDemo =
  !production && env.NODE_ENV !== "test" && env.DEMO_MODE === "true";
const configuredOrigins = new Set(
  env.FRONTEND_ORIGIN.split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
);
if (!production) {
  configuredOrigins.add("http://localhost:3000");
  configuredOrigins.add("http://127.0.0.1:3000");
}

export const isAllowedOrigin = (origin?: string | null): boolean => {
  if (!origin) return true;
  const normalized = origin.trim().replace(/\/$/, "");
  if (configuredOrigins.has(normalized)) return true;
  try {
    const url = new URL(normalized);
    if (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      (url.hostname.endsWith(".vercel.app") &&
        (url.hostname.includes("sme-attendance") ||
          url.hostname.includes("attendance")))
    ) {
      return true;
    }
  } catch {}
  return false;
};

export const allowedOrigins = {
  has(origin: string) {
    return isAllowedOrigin(origin);
  },
};
