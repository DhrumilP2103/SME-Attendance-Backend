import mongoose from "mongoose";
import { z } from "zod";
import {
  connectDatabase,
  initializeDatabase,
  disconnectDatabase,
} from "../config/database.js";
import { User, Counter } from "../modules/models.js";
import { queueAccountEmail, processOutbox } from "../lib/email.js";
import { assert } from "../lib/core.js";

const email = z.string().email().parse(process.env.ADMIN_EMAIL);
const name = z
  .string()
  .min(1)
  .max(120)
  .parse(process.env.ADMIN_NAME || "Workspace Admin");
await connectDatabase();
await initializeDatabase();
await mongoose.connection.transaction(async (session) => {
  await Counter.updateOne(
    { key: "admin-safety" },
    { $inc: { value: 1 } },
    { session },
  );
  assert(
    !(await User.exists({ role: "ADMIN" }).session(session)),
    409,
    "ADMIN_EXISTS",
    "An Admin already exists. Use the invitation workflow.",
  );
  const [user] = await User.create([{ name, email, role: "ADMIN" }], {
    session,
  });
  await queueAccountEmail(user, "INVITE", session);
});
await processOutbox();
console.log(
  "Admin invitation prepared. Check your mailbox, or .local/mail when SMTP is not configured.",
);
await disconnectDatabase();
