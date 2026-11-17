import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { rateLimit } from "express-rate-limit";
import { allowedOrigins } from "./config/env.js";
import { connectDatabase } from "./config/database.js";
import { AppError } from "./lib/core.js";
import { authenticate, csrf } from "./middleware/authenticate.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { employeesRouter } from "./modules/employees/employees.routes.js";
import { managementRouter } from "./modules/roles/roles.routes.js";
import { attendanceRouter } from "./modules/attendance/attendance.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";

export const app = express();
app.disable("x-powered-by");
app.use((req, _res, next) => {
  if (req.url.startsWith("/v1")) {
    req.url = `/api${req.url}`;
  }
  next();
});
const helmetMiddleware: any = (helmet as any).default || helmet;
app.use(helmetMiddleware());
app.use(
  cors({
    origin: (origin, done) => done(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
  }),
);
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
app.use(
  "/api/v1",
  rateLimit({
    windowMs: 60000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.get("/api/v1/health", (_req, res) => res.json({ data: { status: "ok" } }));
app.use("/api/v1", async (_req, _res, next) => {
  try {
    await connectDatabase();
    next();
  } catch (error) {
    next(error);
  }
});
app.use("/api/v1", csrf);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1", authenticate);
app.use("/api/v1/employees", employeesRouter);
app.use("/api/v1/attendance", attendanceRouter);
app.use("/api/v1", managementRouter, reportsRouter, settingsRouter);
app.use((_req, _res, next) =>
  next(new AppError(404, "NOT_FOUND", "Endpoint not found.")),
);
const errors: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return _next(error);
  if (error instanceof ZodError) {
    res
      .status(422)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: error.issues[0]?.message || "Invalid input.",
          fields: Object.fromEntries(
            error.issues.map((i) => [i.path.join("."), i.message]),
          ),
          requestId: req.requestId,
        },
      });
    return;
  }
  if (error?.code === 11000) {
    res
      .status(409)
      .json({
        error: {
          code: "DUPLICATE",
          message: "This record already exists. Refresh and try again.",
          requestId: req.requestId,
        },
      });
    return;
  }
  if (error instanceof AppError) {
    res
      .status(error.status)
      .json({
        error: {
          code: error.code,
          message: error.message,
          requestId: req.requestId,
        },
      });
    return;
  }
  if (
    error?.type === "entity.parse.failed" ||
    error?.type === "entity.too.large"
  ) {
    res
      .status(400)
      .json({
        error: {
          code: "INVALID_BODY",
          message: "Invalid or oversized request body.",
        },
      });
    return;
  }
  console.error("Request failed", {
    requestId: req.requestId,
    name: error?.name,
    code: error?.code,
  });
  res
    .status(500)
    .json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong. Please try again.",
        requestId: req.requestId,
      },
    });
};
app.use(errors);

export default app;
