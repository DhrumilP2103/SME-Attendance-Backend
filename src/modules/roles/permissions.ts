import type { RequestHandler } from "express";
import {
  RolePolicy,
  permissionKeys,
  type Role,
  type Permissions,
  type Permission,
  type UserRecord,
  Employee,
} from "../models.js";
import { assert } from "../../lib/core.js";

const grants = (...keys: Permission[]): Permissions =>
  Object.fromEntries(
    permissionKeys.map((k) => [k, keys.includes(k)]),
  ) as Permissions;
export const defaults: Record<Role, Permissions> = {
  ADMIN: grants(...permissionKeys),
  HR: grants(
    "canLogin",
    "canTakeSelfAttendance",
    "canMarkTeamAttendance",
    "canToggleOT",
    "canViewAllAttendance",
    "canGenerateReports",
    "canExportReports",
    "canViewSalaryImpact",
    "canManageEmployees",
  ),
  EMPLOYEE: grants("canLogin", "canTakeSelfAttendance"),
};
export function configurable(role: Role, key: Permission) {
  if (role === "ADMIN") return key === "canTakeSelfAttendance";
  if (["canConfigureCronEOD", "canManageRights"].includes(key)) return false;
  if (role === "HR") return true;
  return ["canLogin", "canTakeSelfAttendance"].includes(key);
}
export async function effective(user: UserRecord): Promise<Permissions> {
  const policy = await RolePolicy.findOne({ role: user.role }).lean();
  const result = { ...defaults[user.role] };
  for (const key of permissionKeys) {
    if (configurable(user.role, key))
      result[key] =
        user.customPermissions?.[key] ??
        policy?.permissions?.[key] ??
        defaults[user.role][key];
  }
  return result;
}
export const requirePermission =
  (key: Permission): RequestHandler =>
  (req, _res, next) => {
    assert(
      req.auth?.permissions[key],
      403,
      "FORBIDDEN",
      "You do not have permission for this action.",
    );
    next();
  };
export const adminOnly: RequestHandler = (req, _res, next) => {
  assert(
    req.auth?.user.role === "ADMIN",
    403,
    "FORBIDDEN",
    "Administrator access is required.",
  );
  next();
};
export async function employeeScope(req: Express.Request) {
  const { user, permissions } = req.auth!;
  if (
    user.role === "ADMIN" ||
    (user.role === "HR" && permissions.canViewAllAttendance)
  )
    return {};
  return { userId: user._id };
}
export async function scopedEmployee(
  req: Express.Request,
  id: string,
  edit = false,
) {
  const { user, permissions } = req.auth!;
  const scope =
    edit && user.role === "HR" && permissions.canMarkTeamAttendance
      ? {}
      : await employeeScope(req);
  const employee = await Employee.findOne({ $and: [{ _id: id }, scope] });
  assert(employee, 404, "NOT_FOUND", "Employee not found.");
  return employee;
}
export function canSeePay(req: Express.Request, employeeUserId?: unknown) {
  const { user, permissions } = req.auth!;
  return (
    permissions.canViewSalaryImpact ||
    String(employeeUserId) === String(user._id)
  );
}
