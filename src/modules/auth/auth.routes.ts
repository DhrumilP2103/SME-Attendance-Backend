import { Router } from "express";
import mongoose from "mongoose";
import argon2 from "argon2";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { User, Session, Employee, AccountToken, roles } from "../models.js";
import {
  authenticate,
  createSession,
  csrfCookie,
  issueCookies,
  clearCookies,
} from "../../middleware/authenticate.js";
import { effective } from "../roles/permissions.js";
import { assert, hash, token, context } from "../../lib/core.js";
import { queueAccountEmail } from "../../lib/email.js";
import { localDemo } from "../../config/env.js";

export const authRouter = Router();
const limit = rateLimit({
  windowMs: 15 * 60000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMIT",
      message: "Too many attempts. Please try again later.",
    },
  },
});
const password = z.string().min(12, "Use at least 12 characters.").max(128);
const dummyHash = argon2.hash(token());
authRouter.get("/csrf", (req, res) =>
  res.json({ data: { csrfToken: req.cookies.sme_csrf || csrfCookie(res) } }),
);
authRouter.get("/options", (_req, res) =>
  res.json({ data: { demoAvailable: localDemo } }),
);
authRouter.post("/login", limit, async (req, res) => {
  const body = z
    .object({
      email: z.string().email().toLowerCase(),
      password: z.string().min(1).max(128),
      rememberMe: z.boolean().default(false),
    })
    .strict()
    .parse(req.body);
  const user = await User.findOne({ email: body.email }).select(
    "+passwordHash",
  );
  const valid = await argon2.verify(
    user?.passwordHash || (await dummyHash),
    body.password,
  );
  assert(
    valid &&
      user &&
      user.isActive &&
      user.activated &&
      (await effective(user)).canLogin,
    401,
    "INVALID_CREDENTIALS",
    "Email or password is incorrect, or the account is unavailable.",
  );
  const csrfToken = await createSession(
    res,
    user,
    body.rememberMe,
    req.headers["user-agent"] || "",
  );
  res.json({ data: { csrfToken } });
});
authRouter.post("/demo", limit, async (req, res) => {
  assert(localDemo, 404, "NOT_FOUND", "Not found.");
  const { role } = z
    .object({ role: z.enum(roles).default("ADMIN") })
    .strict()
    .parse(req.body);
  const user = await User.findOne({ role, demo: true, isActive: true });
  assert(
    user && (await effective(user)).canLogin,
    403,
    "DEMO_UNAVAILABLE",
    "This demo account is unavailable.",
  );
  res.json({
    data: {
      csrfToken: await createSession(res, user, false, "Local demonstration"),
    },
  });
});
authRouter.post("/refresh", limit, async (req, res) => {
  const raw = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .safeParse(req.cookies.sme_refresh);
  assert(raw.success, 401, "SESSION_EXPIRED", "Please sign in again.");
  const oldHash = hash(raw.data);
  const session = await Session.findOne({
    tokenHash: oldHash,
    revoked: false,
    expiresAt: { $gt: new Date() },
  });
  if (!session) {
    await Session.updateMany({ previousHashes: oldHash }, { revoked: true });
    clearCookies(res);
    assert(false, 401, "SESSION_EXPIRED", "Please sign in again.");
  }
  const user = await User.findById(session.userId);
  assert(
    user &&
      user.isActive &&
      user.activated &&
      user.tokenVersion === session.tokenVersion &&
      (await effective(user)).canLogin,
    401,
    "SESSION_REVOKED",
    "Your session is no longer active.",
  );
  const nextToken = token();
  const updated = await Session.findOneAndUpdate(
    { _id: session._id, tokenHash: oldHash, revoked: false },
    {
      $set: { tokenHash: hash(nextToken) },
      $push: { previousHashes: oldHash },
    },
    { new: true },
  );
  assert(updated, 401, "SESSION_EXPIRED", "The session was already refreshed.");
  await issueCookies(
    res,
    user,
    String(session._id),
    nextToken,
    session.expiresAt,
    session.rememberMe,
  );
  res.json({ data: { refreshed: true } });
});
authRouter.post("/logout", async (req, res) => {
  if (typeof req.cookies.sme_refresh === "string") {
    const value = hash(req.cookies.sme_refresh);
    await Session.updateMany(
      { $or: [{ tokenHash: value }, { previousHashes: value }] },
      { revoked: true },
    );
  }
  clearCookies(res);
  res.status(204).end();
});
authRouter.get("/me", authenticate, async (req, res) => {
  const { user, permissions } = req.auth!;
  const employee = await Employee.findOne({ userId: user._id }).lean();
  res.json({
    data: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      effectivePermissions: permissions,
      employeeId: employee?._id || null,
      company: await context(),
      demo: Boolean(user.demo),
      demoWorkspace: localDemo,
    },
  });
});
authRouter.post("/forgot-password", limit, async (req, res) => {
  const { email } = z
    .object({ email: z.string().email().toLowerCase() })
    .strict()
    .parse(req.body);
  const user = await User.findOne({ email, isActive: true, activated: true });
  if (user)
    await mongoose.connection.transaction(async (session) => {
      await queueAccountEmail(user, "RESET", session);
    });
  res.json({
    data: {
      message:
        "If this account is eligible, a password reset email has been queued.",
    },
  });
});
for (const [path, purpose] of [
  ["/activate", "INVITE"],
  ["/reset-password", "RESET"],
] as const) {
  authRouter.post(path, limit, async (req, res) => {
    const body = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/), password })
      .strict()
      .parse(req.body);
    const passwordHash = await argon2.hash(body.password);
    await mongoose.connection.transaction(async (session) => {
      const entry = await AccountToken.findOneAndUpdate(
        {
          tokenHash: hash(body.token),
          purpose,
          consumed: false,
          expiresAt: { $gt: new Date() },
        },
        { consumed: true },
        { new: true, session },
      );
      assert(
        entry,
        422,
        "INVALID_TOKEN",
        "This link is invalid, expired, or already used.",
      );
      const user = await User.findOneAndUpdate(
        { _id: entry.userId, isActive: true },
        { $set: { passwordHash, activated: true }, $inc: { tokenVersion: 1 } },
        { session },
      );
      assert(user, 422, "ACCOUNT_DISABLED", "This account is unavailable.");
      await Session.updateMany(
        { userId: entry.userId },
        { revoked: true },
        { session },
      );
      await AccountToken.updateMany(
        { userId: entry.userId, consumed: false },
        { consumed: true },
        { session },
      );
    });
    clearCookies(res);
    res.json({ data: { message: "Password saved. You can now sign in." } });
  });
}
authRouter.patch("/password", authenticate, limit, async (req, res) => {
  const body = z
    .object({ currentPassword: z.string().max(128), password })
    .strict()
    .parse(req.body);
  const user = await User.findById(req.auth!.user._id).select("+passwordHash");
  assert(
    user?.passwordHash &&
      (await argon2.verify(user.passwordHash, body.currentPassword)),
    422,
    "INVALID_PASSWORD",
    "Current password is incorrect.",
  );
  const passwordHash = await argon2.hash(body.password);
  await mongoose.connection.transaction(async (session) => {
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
      { session },
    );
    await Session.updateMany(
      { userId: user._id },
      { revoked: true },
      { session },
    );
  });
  clearCookies(res);
  res.json({ data: { message: "Password changed. Please sign in again." } });
});
