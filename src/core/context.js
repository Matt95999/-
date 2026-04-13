import path from "node:path";
import { randomUUID } from "node:crypto";
import { dateKey, nowIso } from "../utils/time.js";

export function createRunContext(rootDir, options = {}) {
  const runId = options.runId || `${dateKey()}-${randomUUID().slice(0, 8)}`;
  const attemptNo = options.attemptNo || 1;
  return {
    runId,
    rootDir,
    dateKey: options.dateKey || dateKey(),
    startedAt: options.startedAt || nowIso(),
    attemptNo,
    attemptRunId: options.attemptRunId || `${runId}-a${attemptNo}`,
    privateDataDir: path.join(rootDir, "private-data"),
    publicDailyDir: path.join(rootDir, "daily"),
    siteDir: path.join(rootDir, "site")
  };
}

export function createAttemptRunContext(runContext, attemptNo) {
  return {
    ...runContext,
    attemptNo,
    attemptRunId: `${runContext.runId}-a${attemptNo}`
  };
}

export function getAttemptArtifactId(runContext) {
  return runContext.attemptRunId || `${runContext.runId}-a${runContext.attemptNo || 1}`;
}
