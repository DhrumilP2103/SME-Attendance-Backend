import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import {
  User,
  RolePolicy,
  Session,
  AuditLog,
  Counter,
  EmailOutbox,
  roles,
  permissionKeys,
} from "../models.js";
import {
  adminOnly,
  configurable,
  defaults,
  effective,
  requirePermission,
} from "./permissions.js";
import { assert, objectId, pagination } from "../../lib/core.js";
import { queueAccountEmail } from "../../lib/email.js";

export const managementRouter = Router();
managementRouter.get("/users", adminOnly, async (req, res) => {
  const { page, limit } = pagination(req.query);
  const role = z.enum(roles).optional().parse(req.query.role);
  const filter = role ? { role } : {};
  const users = await User.find(filter)
    .sort({ name: 1, _id: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  const data = await Promise.all(
    users.map(async (user) => {
      const delivery = await EmailOutbox.findOne({ recipient: user.email })
        .sort({ createdAt: -1 })
        .select("status error createdAt")
        .lean();
      return {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        activated: user.activated,
        customPermissions: user.customPermissions,
        effectivePermissions: await effective(user),
        invitation: delivery,
      };
    }),
  );
  res.json({
    data,
    meta: { page, limit, total: await User.countDocuments(filter) },
  });
});
managementRouter.post(
  "/users/invitations",
  requirePermission("canManageEmployees"),
  async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        email: z.string().email().toLowerCase(),
        role: z.enum(roles),
      })
      .strict()
      .parse(req.body);
    assert(
      req.auth!.user.role === "ADMIN" || body.role === "EMPLOYEE",
      403,
      "FORBIDDEN",
      "Only Admin can invite elevated roles.",
    );
    const result = await mongoose.connection.transaction(async (session) => {
      const [user] = await User.create([body], { session });
      const invitation = await queueAccountEmail(user, "INVITE", session);
      await AuditLog.create(
        [
          {
            actorId: req.auth!.user._id,
            action: "ACCOUNT_INVITED",
            entityId: String(user._id),
            after: { name: user.name, role: user.role },
          },
        ],
        { session },
      );
      return { id: user._id, invitation };
    });
    res.status(201).json({ data: result });
  },
);
managementRouter.post(
  "/users/:id/invitations/resend",
  requirePermission("canManageEmployees"),
  async (req, res) => {
    const user = await User.findById(objectId.parse(req.params.id));
    assert(
      user && user.isActive && !user.activated,
      422,
      "INVITATION",
      "Only active, unactivated accounts can be invited again.",
    );
    assert(
      req.auth!.user.role === "ADMIN" || user.role === "EMPLOYEE",
      403,
      "FORBIDDEN",
      "Cannot invite this account.",
    );
    const invitation = await mongoose.connection.transaction((session) =>
      queueAccountEmail(user, "INVITE", session),
    );
    res.status(202).json({ data: invitation });
  },
);
managementRouter.patch("/users/:id/status", adminOnly, async (req, res) => {
  const id = objectId.parse(req.params.id);
  const { isActive } = z
    .object({ isActive: z.boolean() })
    .strict()
    .parse(req.body);
  await mongoose.connection.transaction(async (session) => {
    await Counter.findOneAndUpdate(
      { key: "admin-safety" },
      { $inc: { value: 1 } },
      { upsert: true, session },
    );
    const user = await User.findById(id).session(session);
    assert(user, 404, "NOT_FOUND", "Account not found.");
    if (!isActive && user.role === "ADMIN")
      assert(
        await User.countDocuments({
          role: "ADMIN",
          isActive: true,
          activated: true,
          _id: { $ne: user._id },
        }).session(session),
        409,
        "LAST_ADMIN",
        "Keep at least one active, activated Admin.",
      );
    await User.updateOne(
      { _id: id },
      { $set: { isActive }, $inc: { tokenVersion: 1 } },
      { session },
    );
    await Session.updateMany({ userId: id }, { revoked: true }, { session });
    await AuditLog.create(
      [
        {
          actorId: req.auth!.user._id,
          action: "ACCOUNT_STATUS",
          entityId: id,
          before: { isActive: user.isActive },
          after: { isActive },
        },
      ],
      { session },
    );
  });
  res.json({ data: { isActive } });
});
managementRouter.get("/roles", adminOnly, async (_req, res) => {
  const policies = await RolePolicy.find().lean();
  res.json({
    data: roles.map((role) => ({
      role,
      permissions:
        policies.find((p) => p.role === role)?.permissions || defaults[role],
      configurable: permissionKeys.filter((key) => configurable(role, key)),
    })),
  });
});
managementRouter.patch(
  "/roles/:role/permissions",
  adminOnly,
  async (req, res) => {
    const role = z.enum(roles).parse(req.params.role);
    const { permissions } = z
      .object({
        permissions: z.partialRecord(z.enum(permissionKeys), z.boolean()),
      })
      .strict()
      .parse(req.body);
    for (const key of Object.keys(
      permissions,
    ) as (typeof permissionKeys)[number][])
      assert(
        configurable(role, key),
        422,
        "FIXED_PERMISSION",
        "This permission is fixed for the selected role.",
      );
    const result = await mongoose.connection.transaction(async (session) => {
      const old = await RolePolicy.findOne({ role }).session(session);
      const next = { ...defaults[role], ...old?.permissions, ...permissions };
      await RolePolicy.updateOne(
        { role },
        { permissions: next },
        { upsert: true, session },
      );
      if (permissions.canLogin === false)
        await Session.updateMany(
          {
            userId: {
              $in: await User.find({ role }).distinct("_id").session(session),
            },
          },
          { revoked: true },
          { session },
        );
      await AuditLog.create(
        [
          {
            actorId: req.auth!.user._id,
            action: "ROLE_PERMISSIONS",
            entityId: role,
            before: old?.permissions,
            after: next,
          },
        ],
        { session },
      );
      return next;
    });
    res.json({ data: result });
  },
);
managementRouter.patch(
  "/users/:id/permissions",
  adminOnly,
  async (req, res) => {
    const id = objectId.parse(req.params.id);
    const { permissions } = z
      .object({
        permissions: z.partialRecord(
          z.enum(permissionKeys),
          z.boolean().nullable(),
        ),
      })
      .strict()
      .parse(req.body);
    const result = await mongoose.connection.transaction(async (session) => {
      const user = await User.findById(id).session(session);
      assert(user, 404, "NOT_FOUND", "Account not found.");
      const before = { ...user.customPermissions },
        next = { ...before };
      for (const key of Object.keys(
        permissions,
      ) as (typeof permissionKeys)[number][]) {
        assert(
          configurable(user.role, key),
          422,
          "FIXED_PERMISSION",
          "This permission is fixed for the selected role.",
        );
        if (permissions[key] === null) delete next[key];
        else next[key] = permissions[key];
      }
      user.customPermissions = next;
      user.markModified("customPermissions");
      if (permissions.canLogin === false) {
        user.tokenVersion += 1;
        await Session.updateMany(
          { userId: id },
          { revoked: true },
          { session },
        );
      }
      await user.save({ session });
      await AuditLog.create(
        [
          {
            actorId: req.auth!.user._id,
            action: "USER_PERMISSIONS",
            entityId: id,
            before,
            after: next,
          },
        ],
        { session },
      );
      return next;
    });
    res.json({ data: result });
  },
);
