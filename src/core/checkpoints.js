import path from "node:path";
import { createRunContext, getAttemptArtifactId } from "./context.js";
import { listJsonFiles, readJson, writeJson } from "../utils/fs.js";
import { nowIso } from "../utils/time.js";

export const STAGE_SEQUENCE = ["discover", "scrape", "score", "summarize", "publish", "feishu"];

export async function saveStageCheckpoint({ runContext, stage, payload }) {
  const record = {
    run: {
      runId: runContext.runId,
      dateKey: runContext.dateKey,
      startedAt: runContext.startedAt,
      attemptNo: runContext.attemptNo,
      attemptRunId: getAttemptArtifactId(runContext)
    },
    stage,
    saved_at: nowIso(),
    payload
  };

  const filePath = path.join(runContext.privateDataDir, "checkpoints", runContext.runId, `${stage}.json`);
  await writeJson(filePath, record);
  return record;
}

export async function loadStageCheckpoints({ rootDir, runId }) {
  const checkpoints = {};
  for (const stage of STAGE_SEQUENCE) {
    const filePath = path.join(rootDir, "private-data", "checkpoints", runId, `${stage}.json`);
    try {
      checkpoints[stage] = await readJson(filePath);
    } catch {
      continue;
    }
  }
  return checkpoints;
}

export async function findLatestResumeTarget({ rootDir, maximumAttempts = Number.POSITIVE_INFINITY }) {
  const incidentFiles = await listJsonFiles(path.join(rootDir, "private-data", "incidents"));
  for (const incidentFile of incidentFiles) {
    const incident = await readJson(incidentFile.fullPath);
    if (!incident?.run_id || typeof incident.attempt_no !== "number") {
      continue;
    }

    if (incident.status === "resolved") {
      continue;
    }

    if (incident.attempt_no >= maximumAttempts) {
      continue;
    }

    if (await hasSuccessfulLaterAttempt({ rootDir, incident })) {
      continue;
    }

    const checkpoints = await loadStageCheckpoints({ rootDir, runId: incident.run_id });
    const checkpointRun = firstCheckpointRun(checkpoints);
    return {
      incident,
      checkpoints,
      runContext: createRunContext(rootDir, {
        runId: incident.run_id,
        dateKey: checkpointRun?.dateKey || inferDateKeyFromRunId(incident.run_id),
        startedAt: checkpointRun?.startedAt || nowIso(),
        attemptNo: incident.attempt_no + 1
      }),
      sourceIncidentFile: incidentFile.fullPath
    };
  }

  return null;
}

export async function markIncidentResolved({ rootDir, incident, resolvedByAttemptNo }) {
  if (!incident?.attempt_run_id) {
    return null;
  }

  const filePath = path.join(
    rootDir,
    "private-data",
    "incidents",
    `${incident.attempt_run_id}-incident.json`
  );

  let existing;
  try {
    existing = await readJson(filePath);
  } catch {
    return null;
  }

  const updated = {
    ...existing,
    status: "resolved",
    resolved_at: nowIso(),
    resolved_by_attempt_no: resolvedByAttemptNo
  };
  await writeJson(filePath, updated);
  return updated;
}

export function shouldReuseCheckpoint({ stage, previousIncident, checkpoints }) {
  if (!previousIncident?.stage || !checkpoints[stage]) {
    return false;
  }

  const stageIndex = STAGE_SEQUENCE.indexOf(stage);
  const failedStageIndex = STAGE_SEQUENCE.indexOf(previousIncident.stage);
  if (stageIndex === -1 || failedStageIndex === -1) {
    return false;
  }

  return stageIndex < failedStageIndex;
}

function firstCheckpointRun(checkpoints) {
  for (const stage of STAGE_SEQUENCE) {
    if (checkpoints[stage]?.run) {
      return checkpoints[stage].run;
    }
  }
  return null;
}

function inferDateKeyFromRunId(runId) {
  const match = String(runId).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : nowIso().slice(0, 10);
}

async function hasSuccessfulLaterAttempt({ rootDir, incident }) {
  const runFiles = await listJsonFiles(path.join(rootDir, "private-data", "runs"));
  for (const runFile of runFiles) {
    try {
      const runRecord = await readJson(runFile.fullPath);
      if (
        runRecord?.run?.runId === incident.run_id &&
        typeof runRecord?.run?.attemptNo === "number" &&
        runRecord.run.attemptNo > incident.attempt_no
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}
