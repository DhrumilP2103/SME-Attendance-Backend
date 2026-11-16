import mongoose from "mongoose";
import { env } from "./env.js";
import {
  allModels,
  CompanyConfig,
  CronConfig,
  Counter,
  RolePolicy,
  roles,
} from "../modules/models.js";
import { defaults } from "../modules/roles/permissions.js";

export async function connectDatabase() {
  const uri = env.MONGODB_URI || "mongodb://127.0.0.1:27017/sme_attendance";
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    // Transactions require a replica set or a sharded MongoDB cluster.
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") {
      throw new Error(
        "MongoDB is reachable but is running standalone. Configure it as a replica set to support attendance, account, and audit transactions.",
      );
    }
    console.log(`MongoDB connected: ${mongoose.connection.name}`);
  } catch (error) {
    await mongoose.disconnect();
    throw error;
  }
}

export async function initializeDatabase() {
  for (const model of allModels) await model.createIndexes();
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
}
export async function disconnectDatabase() {
  await mongoose.disconnect();
}
