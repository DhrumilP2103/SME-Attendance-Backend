import type { UserRecord, Permissions } from "../modules/models.js";
declare global {
  namespace Express {
    interface Request {
      auth?: { user: UserRecord; permissions: Permissions; sessionId: string };
      requestId?: string;
    }
  }
}
export {};
