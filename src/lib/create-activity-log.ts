import { appendFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { UserRecord } from "../modules/models.js";

const logFile = resolve(".local", "create-activity.log");
const sendingLogFile = resolve(".local", "create-activity.sending.log");
let writeQueue = Promise.resolve();

function missingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

type LogRequest = {
  method?: string;
  path?: string;
  requestId?: string;
};

function asText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (
    value &&
    typeof value === "object" &&
    "toHexString" in value &&
    typeof value.toHexString === "function"
  )
    return String(value.toHexString());
  return undefined;
}

export type CreateActivityLogClaim = {
  content: string;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

export async function takeCreateActivityLog(): Promise<CreateActivityLogClaim | null> {
  await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
  try {
    const stranded = await readFile(sendingLogFile, "utf8");
    if (stranded)
      await appendFile(logFile, stranded, { encoding: "utf8", mode: 0o600 });
    await unlink(sendingLogFile);
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
  try {
    await rename(logFile, sendingLogFile);
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
  try {
    const content = await readFile(sendingLogFile, "utf8");
    return {
      content,
      commit: async () => {
        await unlink(sendingLogFile).catch((error) => {
          if (!missingFile(error)) throw error;
        });
      },
      rollback: async () => {
        if (content)
          await appendFile(logFile, content, {
            encoding: "utf8",
            mode: 0o600,
          });
        await unlink(sendingLogFile).catch((error) => {
          if (!missingFile(error)) throw error;
        });
      },
    };
  } catch (error) {
    await unlink(sendingLogFile).catch(() => undefined);
    throw error;
  }
}

export function logCreateActivity(
  user: UserRecord,
  action: string,
  entry: Record<string, unknown>,
  request?: LogRequest,
) {
  const normalizedEntry = Object.fromEntries(
    Object.entries(entry).flatMap(([key, value]) => {
      const text = asText(value);
      return text === undefined ? [] : [[key, text]];
    }),
  );

  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
      await appendFile(
        logFile,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          action,
          entry: normalizedEntry,
          user: {
            id: String(user._id),
            name: user.name,
            email: user.email,
            role: user.role,
          },
          request: {
            method: request?.method,
            path: request?.path,
            requestId: request?.requestId,
          },
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    })
    .catch((error) => {
      console.error("Create activity log failed", {
        requestId: request?.requestId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    });
}
