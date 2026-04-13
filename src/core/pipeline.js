import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findLatestResumeTarget,
  markIncidentResolved,
  saveStageCheckpoint,
  shouldReuseCheckpoint
} from "./checkpoints.js";
import { loadConfig, loadDotEnv, loadEnvConfig } from "./config.js";
import { createAttemptRunContext, createRunContext, getAttemptArtifactId } from "./context.js";
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
  const resumeState =
    mode === "retry_failed_run"
      ? await findLatestResumeTarget({
          rootDir,
          maximumAttempts: config.scoring.maximum_attempts
        })
      : null;

  if (mode === "retry_failed_run" && !resumeState) {
    throw new StageError("retry", "no_resumable_run", "no resumable failed run found");
  }
  const runContext = resumeState?.runContext || createRunContext(rootDir);
  const logger = createLogger(getAttemptArtifactId(runContext));
  const checkpoints = resumeState?.checkpoints || {};

  const execution = await executeWithRemediation({
    runContext,
    scoringConfig: config.scoring,
    envConfig,
    logger,
    executor: async ({ attemptNo, remediation, previousIncident }) => {
      const attemptContext = createAttemptRunContext(runContext, attemptNo);
      const attemptLogger = createLogger(getAttemptArtifactId(attemptContext));
      const effectivePreviousIncident = previousIncident || resumeState?.incident || null;

      const { discovered } = await resolveStage({
        stage: "discover",
        previousIncident: effectivePreviousIncident,
        checkpoints,
        attemptContext,
        logger: attemptLogger,
        compute: async () => ({
          discovered: await discoverCandidates({ rootDir, config, envConfig, logger: attemptLogger })
        })
      });
      if (!discovered.length) {
        throw new StageError("discover", "no_candidates", "no article candidates discovered");
      }

      const { scrapedCandidates, failures } = await resolveStage({
        stage: "scrape",
        previousIncident: effectivePreviousIncident,
        checkpoints,
        attemptContext,
        logger: attemptLogger,
        compute: async () =>
          scrapeCandidates(discovered, {
            envConfig,
            logger: attemptLogger,
            remediation
          })
      });

      const { scored } = await resolveStage({
        stage: "score",
        previousIncident: effectivePreviousIncident,
        checkpoints,
        attemptContext,
        logger: attemptLogger,
        compute: async () => {
          const clusters = buildStoryClusters(scrapedCandidates, config.keywords);
          return {
            scored: scoreStoryClusters(clusters, {
              scoringConfig: config.scoring,
              whitelistConfig: config.whitelist,
              keywordConfig: config.keywords
            })
          };
        }
      });

      const filtered = scored.filter(
        (cluster) => remediation.partialPublish || cluster.score >= config.scoring.minimum_story_score
      );

      if (filtered.length < config.scoring.minimum_digest_story_count && !remediation.partialPublish) {
        throw new StageError(
          "score",
          "insufficient_story_count",
          `only ${filtered.length} scored stories available, below minimum`
        );
      }

      const { digest } = await resolveStage({
        stage: "summarize",
        previousIncident: effectivePreviousIncident,
        checkpoints,
        attemptContext,
        logger: attemptLogger,
        compute: async () => ({
          digest: await summarizeDailyDigest({
            clusters: filtered.length ? filtered : scored.slice(0, config.scoring.minimum_digest_story_count),
            config,
            envConfig,
            remediation,
            logger: attemptLogger
          })
        })
      });

      const { publishResult } = await resolveStage({
        stage: "publish",
        previousIncident: effectivePreviousIncident,
        checkpoints,
        attemptContext,
        logger: attemptLogger,
        compute: async () => ({
          publishResult: await publishDigest({
            digest,
            runContext: attemptContext,
            logger: attemptLogger,
            publicBaseUrl: envConfig.publicBaseUrl
          })
        })
      });

      const feishuResult = await deliverDigestToFeishu({
        digest,
        reportUrl: publishResult.reportUrl,
        envConfig,
        runContext: attemptContext,
        logger: attemptLogger
      });

      const artifacts = {
        mode,
        run: attemptContext,
        resumedFrom: resumeState
          ? {
              runId: resumeState.incident.run_id,
              attemptNo: resumeState.incident.attempt_no,
              failedStage: resumeState.incident.stage
            }
          : null,
        remediation,
        discoveredCount: discovered.length,
        scrapedCount: scrapedCandidates.length,
        scrapeFailures: failures,
        clusters: filtered,
        digest,
        publishResult,
        feishuResult
      };
      const runFile = await saveRunArtifacts({ runContext: attemptContext, artifacts });
      await syncPrivateArtifacts({ envConfig, logger: attemptLogger, runContext: attemptContext });
      return { runFile, digest, publishResult, feishuResult, attemptContext };
    }
  });

  if (execution.success && execution.latestIncident) {
    await markIncidentResolved({
      rootDir,
      incident: execution.latestIncident,
      resolvedByAttemptNo: execution.result.attemptContext.attemptNo
    });
  }

  if (!execution.success) {
    await deliverFailureIncident({
      incident: execution.latestIncident,
      recommendation: execution.recommendation,
      envConfig,
      runContext: createAttemptRunContext(runContext, execution.latestIncident.attempt_no),
      logger
    });
    await syncPrivateArtifacts({ envConfig, logger, runContext });
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

async function resolveStage({ stage, previousIncident, checkpoints, attemptContext, logger, compute }) {
  if (shouldReuseCheckpoint({ stage, previousIncident, checkpoints })) {
    logger.info("reusing checkpoint", {
      stage,
      sourceAttemptRunId: checkpoints[stage].run?.attemptRunId || null
    });
    return checkpoints[stage].payload;
  }

  const payload = await compute();
  checkpoints[stage] = await saveStageCheckpoint({
    runContext: attemptContext,
    stage,
    payload
  });
  return payload;
}
