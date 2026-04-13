import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { syncPrivateArtifacts } from "../src/core/private-sync.js";

test("syncPrivateArtifacts uploads current run artifacts to the configured private repository", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-digest-sync-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const runId = "2026-04-12-sync";
  const privateDataDir = path.join(tempRoot, "private-data");
  await mkdir(path.join(privateDataDir, "runs"), { recursive: true });
  await mkdir(path.join(privateDataDir, "incidents"), { recursive: true });
  await writeFile(path.join(privateDataDir, "runs", `${runId}-a1.json`), '{"ok":true}\n', "utf8");
  await writeFile(path.join(privateDataDir, "runs", `${runId}-a1-feishu-preview.json`), '{"preview":true}\n', "utf8");

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body || "" });
    if ((options.method || "GET") === "GET") {
      return createResponse(404, { message: "Not Found" });
    }
    return createResponse(201, { content: { path: "archive/test.json" } });
  };

  t.after(() => {
    global.fetch = originalFetch;
  });

  const logger = { info() {}, warn() {} };
  const result = await syncPrivateArtifacts({
    envConfig: {
      privateDataRepoPat: "token",
      privateDataRepo: "owner/private-artifacts",
      privateDataRepoBranch: "main",
      privateDataRepoBasePath: "archive"
    },
    logger,
    runContext: {
      runId,
      privateDataDir
    }
  });

  assert.equal(result.failed.length, 0);
  assert.equal(result.uploaded.length, 2);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 2);
  assert.match(calls[0].url, /owner\/private-artifacts\/contents\/archive\/runs\//);
});

test("syncPrivateArtifacts skips uploads when private repo content is unchanged", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-digest-sync-skip-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const runId = "2026-04-12-skip";
  const privateDataDir = path.join(tempRoot, "private-data");
  const fileContent = '{"ok":true}\n';
  await mkdir(path.join(privateDataDir, "runs"), { recursive: true });
  await writeFile(path.join(privateDataDir, "runs", `${runId}-a1.json`), fileContent, "utf8");

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    return createResponse(200, {
      type: "file",
      sha: "existing-sha",
      content: Buffer.from(fileContent).toString("base64")
    });
  };

  t.after(() => {
    global.fetch = originalFetch;
  });

  const logger = { info() {}, warn() {} };
  const result = await syncPrivateArtifacts({
    envConfig: {
      privateDataRepoPat: "token",
      privateDataRepo: "owner/private-artifacts",
      privateDataRepoBranch: "main",
      privateDataRepoBasePath: ""
    },
    logger,
    runContext: {
      runId,
      privateDataDir
    }
  });

  assert.equal(result.uploaded.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
});

function createResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}
