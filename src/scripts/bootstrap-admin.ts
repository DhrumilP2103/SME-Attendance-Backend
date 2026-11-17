import mongoose from "mongoose";
import argon2 from "argon2";
import { z } from "zod";
import {
  connectDatabase,
  initializeDatabase,
  disconnectDatabase,
} from "../config/database.js";
import { User, Employee, Counter } from "../modules/models.js";

const email = (process.env.ADMIN_EMAIL || "admin@gmail.com").toLowerCase();
const name = process.env.ADMIN_NAME || "System Admin";
const password = process.env.ADMIN_PASSWORD || "Admin@123";

await connectDatabase();
await initializeDatabase();

const passwordHash = await argon2.hash(password);
await mongoose.connection.transaction(async (session) => {
  await Counter.updateOne(
    { key: "admin-safety" },
    { $inc: { value: 1 } },
    { session },
  );
  const existing = await User.findOne({ email }).session(session);
  if (existing) {
    existing.name = name;
    existing.passwordHash = passwordHash;
    existing.role = "ADMIN";
    existing.isActive = true;
    existing.activated = true;
    await existing.save({ session });
  } else {
    await User.create(
      [
        {
          name,
          email,
          passwordHash,
          role: "ADMIN",
          isActive: true,
          activated: true,
        },
      ],
      { session },
    );
  }
  await Employee.deleteMany({ email }).session(session);
});

console.log(`Admin account configured successfully: ${email} / ${password}`);
await disconnectDatabase();
