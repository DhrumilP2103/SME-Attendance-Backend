import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { startScheduler } from "./jobs/scheduler.js";
await connectDatabase();
const scheduler = startScheduler();
console.log(
  "EOD and email worker running. Development emails are saved to .local/mail when SMTP is not configured.",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void scheduler.stop();
    setTimeout(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    }, 35000).unref();
  });
