import path from "node:path";
import { resolveRootDir } from "../core/pipeline.js";
import { findLatestRunFile, publishDigest } from "../core/publisher.js";
import { readJson } from "../utils/fs.js";
import { createRunContext } from "../core/context.js";
import { loadEnvConfig } from "../core/config.js";
import { createLogger } from "../utils/logger.js";

const rootDir = resolveRootDir(import.meta.url);
const runContext = createRunContext(rootDir);
const logger = createLogger(runContext.runId);
const latestRunFile = await findLatestRunFile(runContext);

if (!latestRunFile) {
  throw new Error("no run artifacts found");
}

const latestRun = await readJson(latestRunFile);
const envConfig = loadEnvConfig();
const result = await publishDigest({
  digest: latestRun.digest,
  runContext,
  logger,
  publicBaseUrl: envConfig.publicBaseUrl
});

console.log(JSON.stringify({ ok: true, reportUrl: result.reportUrl, sourceRun: path.basename(latestRunFile) }, null, 2));
