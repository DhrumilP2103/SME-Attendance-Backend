import { app } from "./app.js";
import { env, production } from "./config/env.js";
import {
  connectDatabase,
  initializeDatabase,
  disconnectDatabase,
} from "./config/database.js";
import { seedDemo } from "./scripts/seed-demo.js";

await connectDatabase();
await initializeDatabase();
await seedDemo();
const server = app.listen(env.PORT, production ? "0.0.0.0" : "127.0.0.1", () =>
  console.log(`SME API ready at http://localhost:${env.PORT}/api/v1`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
  });
