import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { runPreflightChecks } from "../src/core/preflight.js";

test("runPreflightChecks fails publish_only when no prior run artifact exists", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-digest-preflight-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await seedConfig(tempRoot);
  const result = await runPreflightChecks({ rootDir: tempRoot, mode: "publish_only", env: {} });

  assert.equal(result.ok, false);
  assert.equal(findCheck(result, "latest_run_artifact").status, "fail");
});

test("runPreflightChecks fails when private sync is partially configured", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-digest-preflight-private-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await seedConfig(tempRoot);
  const result = await runPreflightChecks({
    rootDir: tempRoot,
    mode: "daily_run",
    env: {
      PRIVATE_DATA_REPO: "owner/private-artifacts",
      DISCOVERY_PROVIDER_SEARCH_TEMPLATES: "[]",
      DISCOVERY_PROVIDER_REQUEST_HEADERS: "{}"
    }
  });

  assert.equal(result.ok, false);
  assert.equal(findCheck(result, "private_sync_config").status, "fail");
});

async function seedConfig(rootDir) {
  const configDir = path.join(rootDir, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "discovery_keywords.yaml"), '{"themes":[],"query_expansions":[]}\n', "utf8");
  await writeFile(path.join(configDir, "whitelist_sources.yaml"), '{"sources":[]}\n', "utf8");
  await writeFile(path.join(configDir, "scoring_rules.yaml"), '{"maximum_attempts":5}\n', "utf8");
}

function findCheck(result, name) {
  return result.checks.find((check) => check.name === name);
}
