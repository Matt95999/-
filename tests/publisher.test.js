import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { buildReportUrl, findLatestRunFile } from "../src/core/publisher.js";
import { writeJson } from "../src/utils/fs.js";

test("buildReportUrl prefers configured public base url", () => {
  assert.equal(
    buildReportUrl({ publicBaseUrl: "https://example.com/base/", dateKey: "2026-04-12" }),
    "https://example.com/base/daily/2026-04-12/"
  );
  assert.equal(buildReportUrl({ publicBaseUrl: "", dateKey: "2026-04-12" }), "./daily/2026-04-12/");
});

test("findLatestRunFile ignores feishu preview payloads", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ai-wechat-digest-"));
  const runsDir = path.join(rootDir, "private-data", "runs");
  const runFile = path.join(runsDir, "2026-04-12-deadbeef-a1.json");
  const previewFile = path.join(runsDir, "2026-04-12-deadbeef-a1-feishu-preview.json");

  await writeJson(runFile, { digest: { daily_brief_title: "ok" } });
  await writeJson(previewFile, { msg_type: "post" });

  const latestRunFile = await findLatestRunFile({ rootDir });
  assert.equal(latestRunFile, runFile);
});
