import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { createRunContext } from "../src/core/context.js";
import {
  findLatestResumeTarget,
  markIncidentResolved,
  saveStageCheckpoint,
  shouldReuseCheckpoint
} from "../src/core/checkpoints.js";
import { writeJson } from "../src/utils/fs.js";

test("checkpoint retry resumes from latest failed run and next attempt number", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ai-digest-checkpoints-"));

  try {
    const runContext = createRunContext(rootDir, {
      runId: "2026-04-12-test1234",
      dateKey: "2026-04-12",
      startedAt: "2026-04-12T08:00:00.000Z",
      attemptNo: 2
    });

    await saveStageCheckpoint({
      runContext,
      stage: "discover",
      payload: { discovered: [{ url: "https://example.com/a" }] }
    });
    await saveStageCheckpoint({
      runContext,
      stage: "scrape",
      payload: { scrapedCandidates: [{ url: "https://example.com/a" }], failures: [] }
    });
    await saveStageCheckpoint({
      runContext,
      stage: "score",
      payload: { scored: [{ story_id: "story-a", score: 88 }] }
    });

    await writeJson(
      path.join(rootDir, "private-data", "incidents", "2026-04-12-test1234-a2-incident.json"),
      {
        run_id: "2026-04-12-test1234",
        attempt_run_id: "2026-04-12-test1234-a2",
        stage: "summarize",
        error_type: "deepseek_failure",
        root_cause_guess: "timeout",
        attempt_no: 2,
        actions_taken: ["切换到本地摘要回退"],
        status: "retrying",
        created_at: "2026-04-12T08:05:00.000Z"
      }
    );

    const resumeTarget = await findLatestResumeTarget({ rootDir });
    assert.equal(resumeTarget.runContext.runId, "2026-04-12-test1234");
    assert.equal(resumeTarget.runContext.attemptNo, 3);
    assert.deepEqual(
      resumeTarget.checkpoints.discover.payload.discovered,
      [{ url: "https://example.com/a" }]
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("checkpoint reuse only applies to stages completed before the failure stage", () => {
  const checkpoints = {
    discover: { payload: { discovered: [] } },
    scrape: { payload: { scrapedCandidates: [], failures: [] } },
    score: { payload: { scored: [] } },
    summarize: { payload: { digest: { daily_brief_title: "x" } } }
  };
  const previousIncident = { stage: "summarize" };

  assert.equal(shouldReuseCheckpoint({ stage: "discover", previousIncident, checkpoints }), true);
  assert.equal(shouldReuseCheckpoint({ stage: "scrape", previousIncident, checkpoints }), true);
  assert.equal(shouldReuseCheckpoint({ stage: "score", previousIncident, checkpoints }), true);
  assert.equal(shouldReuseCheckpoint({ stage: "summarize", previousIncident, checkpoints }), false);
  assert.equal(shouldReuseCheckpoint({ stage: "publish", previousIncident, checkpoints }), false);
});

test("resolved incidents are skipped when a later successful attempt exists", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ai-digest-checkpoints-"));

  try {
    const incident = {
      run_id: "2026-04-13-test9876",
      attempt_run_id: "2026-04-13-test9876-a1",
      stage: "summarize",
      error_type: "deepseek_failure",
      root_cause_guess: "timeout",
      attempt_no: 1,
      actions_taken: ["切换到本地摘要回退"],
      status: "retrying",
      created_at: "2026-04-13T08:00:00.000Z"
    };

    await writeJson(
      path.join(rootDir, "private-data", "incidents", "2026-04-13-test9876-a1-incident.json"),
      incident
    );
    await writeJson(
      path.join(rootDir, "private-data", "runs", "2026-04-13-test9876-a2.json"),
      {
        run: {
          runId: "2026-04-13-test9876",
          attemptNo: 2
        },
        digest: {
          daily_brief_title: "ok"
        }
      }
    );

    const resumeTarget = await findLatestResumeTarget({ rootDir });
    assert.equal(resumeTarget, null);

    const resolved = await markIncidentResolved({
      rootDir,
      incident,
      resolvedByAttemptNo: 2
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolved_by_attempt_no, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("findLatestResumeTarget skips incidents that already exhausted maximum attempts", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ai-digest-checkpoints-"));

  try {
    await writeJson(
      path.join(rootDir, "private-data", "incidents", "2026-04-13-test5555-a5-incident.json"),
      {
        run_id: "2026-04-13-test5555",
        attempt_run_id: "2026-04-13-test5555-a5",
        stage: "publish",
        error_type: "publish_failure",
        root_cause_guess: "bad output",
        attempt_no: 5,
        actions_taken: ["允许部分发布"],
        status: "manual_review_required",
        created_at: "2026-04-13T09:00:00.000Z"
      }
    );

    const resumeTarget = await findLatestResumeTarget({ rootDir, maximumAttempts: 5 });
    assert.equal(resumeTarget, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
