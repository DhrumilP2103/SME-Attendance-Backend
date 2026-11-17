import dns from "node:dns";
import mongoose from "mongoose";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {}
import argon2 from "argon2";
import { env } from "./env.js";
import {
  allModels,
  CompanyConfig,
  CronConfig,
  Counter,
  RolePolicy,
  User,
  Employee,
  roles,
} from "../modules/models.js";
import { defaults } from "../modules/roles/permissions.js";

let connectPromise: Promise<void> | null = null;

export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const uri = env.MONGODB_URI || "mongodb://127.0.0.1:27017/sme_attendance";
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
      // Check if replica set or sharded cluster is present for transactions
      const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
      const isReplicaSet = Boolean(hello.setName || hello.msg === "isdbgrid");
      if (!isReplicaSet) {
        console.warn(
          "MongoDB is running in standalone mode (no replica set detected). Multi-document transactions will execute with direct fallback."
        );
        mongoose.connection.transaction = async function (fn: any) {
          return fn(null);
        };
      }
      console.log(`MongoDB connected: ${mongoose.connection.name}`);
    } catch (error) {
      console.error("MongoDB error:", error);
      await mongoose.disconnect();
      throw error;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

export async function initializeDatabase() {
  for (const model of allModels) {
    try {
      await model.createIndexes();
    } catch (err: any) {
      if (err?.code === 86) {
        console.warn(`Index conflict for ${model.modelName}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  await CompanyConfig.updateOne(
    { key: "company" },
    { $setOnInsert: { name: "Acme Industries", currency: "INR" } },
    { upsert: true },
  );
  await CronConfig.updateOne(
    { taskName: "EOD_ATTENDANCE_REPORT" },
    { $setOnInsert: { isEnabled: false, timezone: "Asia/Kolkata" } },
    { upsert: true },
  );
  await Counter.updateOne(
    { key: "employee" },
    { $setOnInsert: { value: 1000 } },
    { upsert: true },
  );
  await Counter.updateOne(
    { key: "admin-safety" },
    { $setOnInsert: { value: 0 } },
    { upsert: true },
  );
  for (const role of roles)
    await RolePolicy.updateOne(
      { role },
      { $setOnInsert: { permissions: defaults[role] } },
      { upsert: true },
    );

  // Ensure default admin user is seeded with admin@gmail.com / Admin@123 (Admin is not an employee)
  const adminEmail = "admin@gmail.com";
  await Employee.deleteMany({ email: adminEmail });
  const existingAdmin = await User.findOne({ email: adminEmail }).select(
    "+passwordHash",
  );
  if (!existingAdmin) {
    const passwordHash = await argon2.hash("Admin@123");
    await User.create({
      name: "System Admin",
      email: adminEmail,
      passwordHash,
      role: "ADMIN",
      isActive: true,
      activated: true,
    });
  } else {
    const valid = await argon2
      .verify(existingAdmin.passwordHash || "", "Admin@123")
      .catch(() => false);
    if (!valid || !existingAdmin.activated || !existingAdmin.isActive) {
      existingAdmin.passwordHash = await argon2.hash("Admin@123");
      existingAdmin.activated = true;
      existingAdmin.isActive = true;
      await existingAdmin.save();
    }
  }
}
export async function disconnectDatabase() {
  await mongoose.disconnect();
}
