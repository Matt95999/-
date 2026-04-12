import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadDotEnv, loadEnvConfig } from "./config.js";
import { createRunContext } from "./context.js";
import { StageError } from "./errors.js";
import { discoverCandidates } from "../providers/discovery.js";
import { scrapeCandidates } from "../providers/scraper.js";
import { buildStoryClusters } from "./clustering.js";
import { scoreStoryClusters } from "./scoring.js";
import { summarizeDailyDigest } from "./summarizer.js";
import { publishDigest, saveRunArtifacts } from "./publisher.js";
import { deliverDigestToFeishu, deliverFailureIncident } from "./feishu.js";
import { executeWithRemediation } from "./remediation.js";
import { syncPrivateArtifacts } from "./private-sync.js";
import { createLogger } from "../utils/logger.js";

export async function runDailyPipeline({ rootDir, mode = "daily_run" }) {
  await loadDotEnv(rootDir);
  const config = await loadConfig(rootDir);
  const envConfig = loadEnvConfig();
  const runContext = createRunContext(rootDir);
  const logger = createLogger(runContext.runId);

  const execution = await executeWithRemediation({
    runContext,
    scoringConfig: config.scoring,
    envConfig,
    logger,
    executor: async ({ attemptNo, remediation }) => {
      const attemptContext = { ...runContext, attemptNo };
      const discovered = await discoverCandidates({ rootDir, config, envConfig, logger });
      if (!discovered.length) {
        throw new StageError("discover", "no_candidates", "no article candidates discovered");
      }

      const { scrapedCandidates, failures } = await scrapeCandidates(discovered, {
        envConfig,
        logger,
        remediation
      });

      const clusters = buildStoryClusters(scrapedCandidates, config.keywords);
      const scored = scoreStoryClusters(clusters, {
        scoringConfig: config.scoring,
        whitelistConfig: config.whitelist,
        keywordConfig: config.keywords
      });

      const filtered = scored.filter(
        (cluster) => remediation.partialPublish || cluster.score >= config.scoring.minimum_story_score
      );

      if (filtered.length < config.scoring.minimum_digest_story_count && !remediation.partialPublish) {
        throw new StageError(
          "discover",
          "insufficient_story_count",
          `only ${filtered.length} scored stories available, below minimum`
        );
      }

      const digest = await summarizeDailyDigest({
        clusters: filtered.length ? filtered : scored.slice(0, config.scoring.minimum_digest_story_count),
        config,
        envConfig,
        remediation,
        logger
      });

      const publishResult = await publishDigest({
        digest,
        runContext: attemptContext,
        logger,
        publicBaseUrl: envConfig.publicBaseUrl
      });

      const feishuResult = await deliverDigestToFeishu({
        digest,
        reportUrl: publishResult.reportUrl,
        envConfig,
        runContext: attemptContext,
        logger
      });

      const artifacts = {
        mode,
        run: attemptContext,
        discoveredCount: discovered.length,
        scrapedCount: scrapedCandidates.length,
        scrapeFailures: failures,
        clusters: filtered,
        digest,
        publishResult,
        feishuResult
      };
      const runFile = await saveRunArtifacts({ runContext: attemptContext, artifacts });
      await syncPrivateArtifacts({ envConfig, logger });
      return { runFile, digest, publishResult, feishuResult };
    }
  });

  if (!execution.success) {
    await deliverFailureIncident({
      incident: execution.latestIncident,
      recommendation: execution.recommendation,
      envConfig,
      runContext,
      logger
    });
    throw new StageError(
      execution.latestIncident.stage,
      execution.latestIncident.error_type,
      execution.latestIncident.root_cause_guess,
      execution.latestIncident
    );
  }

  return execution.result;
}

export function resolveRootDir(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..", "..");
}
