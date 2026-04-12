import path from "node:path";
import { randomUUID } from "node:crypto";
import { dateKey, nowIso } from "../utils/time.js";

export function createRunContext(rootDir, attemptNo = 1) {
  const runId = `${dateKey()}-${randomUUID().slice(0, 8)}-a${attemptNo}`;
  return {
    runId,
    rootDir,
    dateKey: dateKey(),
    startedAt: nowIso(),
    attemptNo,
    privateDataDir: path.join(rootDir, "private-data"),
    publicDailyDir: path.join(rootDir, "daily"),
    siteDir: path.join(rootDir, "site")
  };
}
