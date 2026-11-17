import { Schema, model, Types } from "mongoose";

export const roles = ["ADMIN", "HR", "EMPLOYEE"] as const;
export type Role = (typeof roles)[number];
export const permissionKeys = [
  "canLogin",
  "canTakeSelfAttendance",
  "canMarkTeamAttendance",
  "canToggleOT",
  "canViewAllAttendance",
  "canGenerateReports",
  "canExportReports",
  "canViewSalaryImpact",
  "canConfigureCronEOD",
  "canManageRights",
  "canManageEmployees",
] as const;
export type Permission = (typeof permissionKeys)[number];
export type Permissions = Record<Permission, boolean>;
const ref = (name: string) => ({ type: Schema.Types.ObjectId, ref: name });
const money = {
  type: Number,
  min: 0,
  max: 1e12,
  validate: Number.isSafeInteger,
  default: 0,
};
export interface UserRecord {
  _id: Types.ObjectId;
  name: string;
  email: string;
  passwordHash?: string;
  role: Role;
  customPermissions: Partial<Permissions>;
  tokenVersion: number;
  isActive: boolean;
  activated: boolean;
  demo: boolean;
}
export const User = model<UserRecord>(
  "User",
  new Schema<UserRecord>(
    {
      name: { type: String, required: true, maxlength: 120 },
      email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
      },
      passwordHash: { type: String, select: false },
      role: { type: String, enum: roles, default: "EMPLOYEE" },
      customPermissions: { type: Schema.Types.Mixed, default: {} },
      tokenVersion: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true },
      activated: { type: Boolean, default: false },
      demo: { type: Boolean, default: false },
    },
    { timestamps: true },
  ),
);

export const RolePolicy = model(
  "RolePolicy",
  new Schema(
    {
      role: { type: String, enum: roles, unique: true, required: true },
      permissions: { type: Schema.Types.Mixed, required: true },
    },
    { timestamps: true },
  ),
);
export const Session = model(
  "Session",
  new Schema(
    {
      userId: { ...ref("User"), required: true, index: true },
      tokenHash: { type: String, required: true, unique: true },
      previousHashes: { type: [String], default: [] },
      tokenVersion: { type: Number, required: true },
      rememberMe: { type: Boolean, default: false },
      expiresAt: { type: Date, required: true, index: { expires: 0 } },
      revoked: { type: Boolean, default: false },
      device: String,
    },
    { timestamps: true },
  ),
);
export const AccountToken = model(
  "AccountToken",
  new Schema(
    {
      userId: { ...ref("User"), required: true },
      purpose: { type: String, enum: ["INVITE", "RESET"], required: true },
      tokenHash: { type: String, required: true, unique: true },
      expiresAt: { type: Date, required: true, index: { expires: 0 } },
      consumed: { type: Boolean, default: false },
    },
    { timestamps: true },
  ),
);
export const Employee = model(
  "Employee",
  new Schema(
    {
      userId: { ...ref("User"), unique: true, required: true },
      employeeCode: { type: String, unique: true, required: true },
      fullName: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, default: "" },
      joiningDate: { type: String, required: true },
      department: { type: String, required: true },
      designation: { type: String, required: true },
      profilePhotoUrl: { type: String, default: "" },
      payType: { type: String, enum: ["SALARIED", "HOURLY"], required: true },
      baseSalary: money,
      hourlyRate: money,
      salaryDivisorPolicy: {
        type: String,
        enum: ["FIXED_26", "FIXED_30", "CALENDAR"],
        default: "FIXED_30",
      },
      shift: {
        startTime: { type: String, default: "09:00" },
        endTime: { type: String, default: "18:00" },
        graceMinutes: { type: Number, default: 15 },
        standardDailyHours: { type: Number, default: 8 },
      },
      weeklyOffDays: { type: [Number], default: [0] },
      assignedClientOrCustomer: { ...ref("User"), default: null },
      status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
      version: { type: Number, default: 1 },
    },
    { timestamps: true },
  ),
);
export const Counter = model(
  "Counter",
  new Schema({
    key: { type: String, unique: true },
    value: { type: Number, default: 1000 },
  }),
);
export const statuses = [
  "PRESENT",
  "ABSENT",
  "HALF_DAY",
  "LEAVE",
  "HOLIDAY",
] as const;
const attendanceSchema = new Schema(
  {
    employeeId: { ...ref("Employee"), required: true },
    workDate: { type: String, required: true },
    status: { type: String, enum: statuses, required: true },
    inTime: { type: Date, default: null },
    outTime: { type: Date, default: null },
    totalHours: { type: Number, default: 0 },
    regularMinutes: { type: Number, min: 0, default: 0 },
    regularApproved: { type: Boolean, default: false },
    isIncomplete: { type: Boolean, default: false },
    isOvertime: { type: Boolean, default: false },
    otAmount: money,
    otRemark: { type: String, default: "" },
    markedBy: ref("User"),
    lastModifiedBy: ref("User"),
    approvedBy: ref("User"),
    modificationReason: { type: String, default: "" },
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);
attendanceSchema.index({ employeeId: 1, workDate: 1 }, { unique: true });
export const Attendance = model("Attendance", attendanceSchema);
export const AuditLog = model(
  "AuditLog",
  new Schema(
    {
      actorId: ref("User"),
      action: { type: String, required: true },
      entityId: { type: String, required: true, index: true },
      before: Schema.Types.Mixed,
      after: Schema.Types.Mixed,
      reason: String,
    },
    { timestamps: true },
  ),
);
export const CompanyConfig = model(
  "CompanyConfig",
  new Schema(
    {
      key: { type: String, unique: true, default: "company" },
      name: { type: String, default: "Acme Industries" },
      currency: { type: String, default: "INR" },
    },
    { timestamps: true },
  ),
);
export const CronConfig = model(
  "CronConfig",
  new Schema(
    {
      taskName: {
        type: String,
        unique: true,
        default: "EOD_ATTENDANCE_REPORT",
      },
      isEnabled: { type: Boolean, default: false },
      scheduledTime: { type: String, default: "20:00" },
      timezone: { type: String, default: "Asia/Kolkata" },
      adminRecipients: { type: [String], default: [] },
      sections: {
        summary: { type: Boolean, default: true },
        absent: { type: Boolean, default: true },
        incomplete: { type: Boolean, default: true },
        overtime: { type: Boolean, default: true },
      },
      lastRunAt: Date,
      lastStatus: String,
      lastErrorMessage: String,
      updatedBy: ref("User"),
    },
    { timestamps: true },
  ),
);
export const EodRun = model(
  "EodRun",
  new Schema(
    {
      runKey: { type: String, required: true, unique: true },
      workDate: { type: String, required: true },
      trigger: { type: String, enum: ["MANUAL", "SCHEDULED"], required: true },
      status: {
        type: String,
        enum: ["PENDING", "RUNNING", "SUCCESS", "FAILED"],
        default: "PENDING",
      },
      attempts: { type: Number, default: 0 },
      leaseUntil: Date,
      error: String,
      result: String,
      requestedBy: ref("User"),
    },
    { timestamps: true },
  ),
);
export const EmailOutbox = model(
  "EmailOutbox",
  new Schema(
    {
      recipient: { type: String, required: true },
      encryptedPayload: { type: String, required: true },
      status: {
        type: String,
        enum: ["PENDING", "RUNNING", "SENT", "FAILED"],
        default: "PENDING",
      },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: { type: Date, default: Date.now },
      error: String,
    },
    { timestamps: true },
  ),
);
export const IdempotencyRecord = model(
  "IdempotencyRecord",
  new Schema({
    key: { type: String, unique: true, required: true },
    response: Schema.Types.Mixed,
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  }),
);
export const allModels = [
  User,
  RolePolicy,
  Session,
  AccountToken,
  Employee,
  Counter,
  Attendance,
  AuditLog,
  CompanyConfig,
  CronConfig,
  EodRun,
  EmailOutbox,
  IdempotencyRecord,
];
