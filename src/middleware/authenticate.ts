import type { RequestHandler, Response } from "express";
import { EncryptJWT, jwtDecrypt } from "jose";
import { accessKey, allowedOrigins, production } from "../config/env.js";
import { Session, User, type UserRecord } from "../modules/models.js";
import { effective } from "../modules/roles/permissions.js";
import { AppError, assert, equal, token, hash } from "../lib/core.js";

const baseCookie = {
  httpOnly: true,
  secure: production,
  sameSite: "lax" as const,
};
export function csrfCookie(res: Response) {
  const value = token();
  res.cookie("sme_csrf", value, { ...baseCookie, path: "/api/v1" });
  return value;
}
export const csrf: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  let requestOrigin = req.headers.origin || "";
  if (!requestOrigin && req.headers.referer) {
    try {
      requestOrigin = new URL(req.headers.referer).origin;
    } catch {}
  }
  assert(
    !requestOrigin || allowedOrigins.has(requestOrigin),
    403,
    "CSRF",
    "Untrusted request origin.",
  );
  assert(
    equal(req.cookies.sme_csrf, req.headers["x-csrf-token"]),
    403,
    "CSRF",
    "Session protection expired. Please reload the page.",
  );
  next();
};
export async function issueCookies(
  res: Response,
  user: UserRecord,
  sessionId: string,
  refresh: string,
  expiresAt: Date,
  rememberMe: boolean,
) {
  const expiry = Math.min(
    Math.floor(Date.now() / 1000) + 900,
    Math.floor(expiresAt.getTime() / 1000),
  );
  const access = await new EncryptJWT({ sid: sessionId, tv: user.tokenVersion })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setSubject(String(user._id))
    .setIssuer("sme-api")
    .setAudience("sme-web")
    .setIssuedAt()
    .setExpirationTime(expiry)
    .encrypt(accessKey);
  res.cookie("sme_access", access, { ...baseCookie, path: "/api/v1" });
  res.cookie("sme_refresh", refresh, {
    ...baseCookie,
    path: "/api/v1/auth",
    ...(rememberMe
      ? { maxAge: Math.max(0, expiresAt.getTime() - Date.now()) }
      : {}),
  });
}
export async function createSession(
  res: Response,
  user: UserRecord,
  rememberMe: boolean,
  device: string,
) {
  const refresh = token();
  const session = await Session.create({
    userId: user._id,
    tokenHash: hash(refresh),
    tokenVersion: user.tokenVersion,
    rememberMe,
    device: device.slice(0, 300),
    expiresAt: new Date(
      Date.now() + (rememberMe ? 30 * 86400000 : 8 * 3600000),
    ),
  });
  await issueCookies(
    res,
    user,
    String(session._id),
    refresh,
    session.expiresAt,
    rememberMe,
  );
  return csrfCookie(res);
}
export function clearCookies(res: Response) {
  res.clearCookie("sme_access", { ...baseCookie, path: "/api/v1" });
  res.clearCookie("sme_refresh", { ...baseCookie, path: "/api/v1/auth" });
  res.clearCookie("sme_csrf", { ...baseCookie, path: "/api/v1" });
}
export const authenticate: RequestHandler = async (req, _res, next) => {
  let payload;
  try {
    payload = (
      await jwtDecrypt(req.cookies.sme_access || "", accessKey, {
        issuer: "sme-api",
        audience: "sme-web",
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      })
    ).payload;
  } catch {
    throw new AppError(401, "SESSION_EXPIRED", "Please sign in to continue.");
  }
  const [user, session] = await Promise.all([
    User.findById(payload.sub).lean(),
    Session.findOne({
      _id: payload.sid,
      revoked: false,
      expiresAt: { $gt: new Date() },
    }).lean(),
  ]);
  assert(
    user &&
      session &&
      String(session.userId) === String(user._id) &&
      user.isActive &&
      user.activated &&
      user.tokenVersion === payload.tv,
    401,
    "SESSION_REVOKED",
    "This session is no longer active.",
  );
  const permissions = await effective(user);
  assert(
    permissions.canLogin,
    401,
    "LOGIN_DISABLED",
    "Your account no longer has sign-in access.",
  );
  req.auth = { user, permissions, sessionId: String(session._id) };
  next();
};
