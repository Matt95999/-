import path from "node:path";
import { ensureDir, listJsonFiles, readJson, writeJson, writeText } from "../utils/fs.js";
import { renderDigestMarkdown } from "../renderers/markdown.js";
import { renderDigestHtml } from "../renderers/html.js";

export async function publishDigest({ digest, runContext, logger, publicBaseUrl }) {
  const markdown = renderDigestMarkdown(digest);
  const html = renderDigestHtml(digest);

  const dailyMarkdownPath = path.join(runContext.publicDailyDir, `${runContext.dateKey}.md`);
  const siteDailyDir = path.join(runContext.siteDir, "daily", runContext.dateKey);
  const siteDailyPath = path.join(siteDailyDir, "index.html");
  const latestJsonPath = path.join(runContext.siteDir, "latest.json");
  const historyJsonPath = path.join(runContext.siteDir, "history.json");
  const siteIndexPath = path.join(runContext.siteDir, "index.html");

  await ensureDir(siteDailyDir);
  await writeText(dailyMarkdownPath, markdown);
  await writeText(siteDailyPath, html);
  await writeText(siteIndexPath, html);

  const reportUrl = publicBaseUrl
    ? `${publicBaseUrl.replace(/\/$/, "")}/daily/${runContext.dateKey}/`
    : `./daily/${runContext.dateKey}/`;

  const publicDigest = sanitizePublicDigest(digest, reportUrl);
  await writeJson(latestJsonPath, publicDigest);
  await updateHistory(historyJsonPath, publicDigest);

  logger.info("public digest published", { reportUrl, markdown: dailyMarkdownPath, site: siteDailyPath });

  return {
    reportUrl,
    dailyMarkdownPath,
    siteDailyPath,
    latestJsonPath
  };
}

function sanitizePublicDigest(digest, reportUrl) {
  return {
    ...digest,
    report_url: reportUrl
  };
}

async function updateHistory(historyJsonPath, publicDigest) {
  let history = [];
  try {
    history = await readJson(historyJsonPath);
  } catch {
    history = [];
  }

  const filtered = history.filter((item) => item.generated_at !== publicDigest.generated_at);
  filtered.unshift(publicDigest);
  await writeJson(historyJsonPath, filtered.slice(0, 30));
}

export async function saveRunArtifacts({ runContext, artifacts }) {
  const runFile = path.join(runContext.privateDataDir, "runs", `${runContext.runId}.json`);
  await writeJson(runFile, artifacts);
  return runFile;
}

export async function findLatestRunFile(runContext) {
  const files = await listJsonFiles(path.join(runContext.rootDir, "private-data", "runs"));
  return files[0]?.fullPath || null;
}
