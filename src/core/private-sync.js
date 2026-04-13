import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { createTimeoutSignal } from "../utils/http.js";

const GITHUB_API_BASE_URL = "https://api.github.com";

export async function syncPrivateArtifacts({ envConfig, logger, runContext }) {
  if (!envConfig.privateDataRepoPat || !envConfig.privateDataRepo) {
    logger.info("private data sync skipped");
    return { synced: false, reason: "missing_private_repo_settings" };
  }

  const files = await collectRunArtifacts(runContext);
  if (!files.length) {
    logger.info("private data sync skipped", { reason: "no_current_run_artifacts" });
    return { synced: false, reason: "no_current_run_artifacts" };
  }

  const uploaded = [];
  const skipped = [];
  const failed = [];

  for (const file of files) {
    try {
      const content = await readFile(file.fullPath);
      const result = await syncFileToGithub({
        envConfig,
        relativePath: file.relativePath,
        content
      });

      if (result.status === "skipped") {
        skipped.push(result.path);
      } else {
        uploaded.push({ path: result.path, status: result.status });
      }
    } catch (error) {
      failed.push({ path: file.relativePath, error: error.message });
    }
  }

  if (failed.length) {
    logger.warn("private data sync completed with failures", {
      repo: envConfig.privateDataRepo,
      branch: envConfig.privateDataRepoBranch,
      uploaded: uploaded.length,
      skipped: skipped.length,
      failed
    });
  } else {
    logger.info("private data sync completed", {
      repo: envConfig.privateDataRepo,
      branch: envConfig.privateDataRepoBranch,
      uploaded: uploaded.length,
      skipped: skipped.length
    });
  }

  return {
    synced: uploaded.length > 0,
    repo: envConfig.privateDataRepo,
    branch: envConfig.privateDataRepoBranch,
    uploaded,
    skipped,
    failed
  };
}

async function collectRunArtifacts(runContext) {
  const matches = [];
  const targets = [
    {
      dirPath: path.join(runContext.privateDataDir, "runs"),
      predicate: (entry) => entry.name.startsWith(runContext.runId)
    },
    {
      dirPath: path.join(runContext.privateDataDir, "incidents"),
      predicate: (entry) => entry.name.startsWith(runContext.runId)
    },
    {
      dirPath: path.join(runContext.privateDataDir, "checkpoints", runContext.runId),
      predicate: (entry) => entry.name.endsWith(".json")
    }
  ];

  for (const target of targets) {
    const entries = await listMatchingEntries(target.dirPath, target.predicate);
    for (const entry of entries) {
      matches.push({
        fullPath: entry.fullPath,
        relativePath: path.relative(runContext.privateDataDir, entry.fullPath).split(path.sep).join("/")
      });
    }
  }

  return matches.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function listMatchingEntries(dirPath, predicate) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && predicate(entry))
      .map((entry) => ({ fullPath: path.join(dirPath, entry.name), name: entry.name }));
  } catch {
    return [];
  }
}

async function syncFileToGithub({ envConfig, relativePath, content }) {
  const targetPath = joinRepoPath(envConfig.privateDataRepoBasePath, relativePath);
  const existing = await fetchGithubFile({
    repo: envConfig.privateDataRepo,
    branch: envConfig.privateDataRepoBranch,
    token: envConfig.privateDataRepoPat,
    targetPath
  });

  if (existing && Buffer.compare(existing.content, content) === 0) {
    return { status: "skipped", path: targetPath };
  }

  const response = await fetch(buildWriteContentsUrl(envConfig.privateDataRepo, targetPath), {
    method: "PUT",
    signal: createTimeoutSignal(30000),
    headers: buildGithubHeaders(envConfig.privateDataRepoPat),
    body: JSON.stringify({
      message: `chore: sync private artifacts ${relativePath}`,
      branch: envConfig.privateDataRepoBranch,
      content: content.toString("base64"),
      ...(existing?.sha ? { sha: existing.sha } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`github contents api failed with status ${response.status}: ${await response.text()}`);
  }

  return { status: existing ? "updated" : "created", path: targetPath };
}

async function fetchGithubFile({ repo, branch, token, targetPath }) {
  const response = await fetch(buildReadContentsUrl(repo, targetPath, branch), {
    method: "GET",
    signal: createTimeoutSignal(15000),
    headers: buildGithubHeaders(token)
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`github contents lookup failed with status ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  if (data.type !== "file") {
    throw new Error(`github target is not a file: ${targetPath}`);
  }

  return {
    sha: data.sha,
    content: Buffer.from((data.content || "").replace(/\n/g, ""), "base64")
  };
}

function buildReadContentsUrl(repo, targetPath, branch) {
  const encodedPath = targetPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${GITHUB_API_BASE_URL}/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
}

function buildWriteContentsUrl(repo, targetPath) {
  const encodedPath = targetPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${GITHUB_API_BASE_URL}/repos/${repo}/contents/${encodedPath}`;
}

function buildGithubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28"
  };
}

function joinRepoPath(prefix, filePath) {
  return [prefix, filePath].filter(Boolean).join("/");
}
