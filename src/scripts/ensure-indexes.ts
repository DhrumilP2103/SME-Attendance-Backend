import {
  connectDatabase,
  initializeDatabase,
  disconnectDatabase,
} from "../config/database.js";
await connectDatabase();
await initializeDatabase();
console.log("Required indexes and initial policies are ready.");
await disconnectDatabase();
