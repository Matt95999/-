import path from "node:path";
import { resolveRootDir } from "../core/pipeline.js";
import { buildReportUrl, findLatestRunFile } from "../core/publisher.js";
import { deliverDigestToFeishu } from "../core/feishu.js";
import { loadDotEnv, loadEnvConfig } from "../core/config.js";
import { createRunContext } from "../core/context.js";
import { createLogger } from "../utils/logger.js";
import { readJson } from "../utils/fs.js";

const rootDir = resolveRootDir(import.meta.url);
await loadDotEnv(rootDir);

const runContext = createRunContext(rootDir);
const logger = createLogger(runContext.runId);
const envConfig = loadEnvConfig();
const latestRunFile = await findLatestRunFile(runContext);

if (!latestRunFile) {
  throw new Error("no run artifacts found");
}

const latestRun = await readJson(latestRunFile);
if (!latestRun.digest) {
  throw new Error(`latest run artifact is missing digest: ${path.basename(latestRunFile)}`);
}

const reportUrl = resolveReportUrl(latestRun, envConfig);
const feishuResult = await deliverDigestToFeishu({
  digest: latestRun.digest,
  reportUrl,
  envConfig,
  runContext,
  logger
});

console.log(
  JSON.stringify(
    {
      ok: true,
      sourceRun: path.basename(latestRunFile),
      reportUrl,
      delivered: feishuResult.delivered,
      previewPath: feishuResult.previewPath || null
    },
    null,
    2
  )
);

function resolveReportUrl(latestRun, envConfig) {
  if (envConfig.publicBaseUrl && latestRun.run?.dateKey) {
    return buildReportUrl({ publicBaseUrl: envConfig.publicBaseUrl, dateKey: latestRun.run.dateKey });
  }

  if (latestRun.publishResult?.reportUrl) {
    return latestRun.publishResult.reportUrl;
  }

  if (latestRun.run?.dateKey) {
    return buildReportUrl({ publicBaseUrl: "", dateKey: latestRun.run.dateKey });
  }

  throw new Error("unable to resolve report url for latest run artifact");
}
