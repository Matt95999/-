import process from "node:process";
import { loadConfig, loadDotEnv, loadEnvConfig } from "./config.js";
import { findLatestRunFile } from "./publisher.js";
import { findLatestResumeTarget } from "./checkpoints.js";

const KNOWN_MODES = new Set(["daily_run", "retry_failed_run", "publish_only", "feishu_only", "manual_review"]);

export async function runPreflightChecks({ rootDir, mode = "daily_run", env = process.env }) {
  await loadDotEnv(rootDir);

  const checks = [];
  const envConfig = loadEnvConfig(env);
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);

  pushCheck(checks, "mode", KNOWN_MODES.has(mode) ? "pass" : "fail", `mode=${mode}`);
  pushCheck(checks, "node_version", nodeMajor >= 20 ? "pass" : "fail", `node=${process.versions.node}`);

  let config = null;
  try {
    config = await loadConfig(rootDir);
    pushCheck(checks, "config_files", "pass", "config loaded");
  } catch (error) {
    pushCheck(checks, "config_files", "fail", error.message);
  }

  pushCheck(
    checks,
    "discovery_search_templates",
    Array.isArray(envConfig.discoveryProviderSearchTemplates) ? "pass" : "fail",
    `count=${Array.isArray(envConfig.discoveryProviderSearchTemplates) ? envConfig.discoveryProviderSearchTemplates.length : 0}`
  );

  pushCheck(
    checks,
    "discovery_request_headers",
    isPlainObject(envConfig.discoveryProviderRequestHeaders) ? "pass" : "fail",
    `keys=${isPlainObject(envConfig.discoveryProviderRequestHeaders) ? Object.keys(envConfig.discoveryProviderRequestHeaders).length : 0}`
  );

  pushCheck(
    checks,
    "public_base_url",
    envConfig.publicBaseUrl ? "pass" : "warn",
    envConfig.publicBaseUrl || "missing, publish output will use relative URLs"
  );

  pushCheck(
    checks,
    "feishu_webhook",
    envConfig.feishuWebhookUrl ? "pass" : "warn",
    envConfig.feishuWebhookUrl ? "configured" : "missing, delivery will fall back to preview files"
  );

  pushCheck(
    checks,
    "deepseek_api",
    envConfig.deepseekApiKey ? "pass" : "warn",
    envConfig.deepseekApiKey ? "configured" : "missing, pipeline will use local summary fallback"
  );

  pushCheck(
    checks,
    "deepseek_runtime",
    "pass",
    `timeout=${envConfig.deepseekTimeoutMs}ms retries=${envConfig.deepseekMaxRetries} retryDelay=${envConfig.deepseekRetryDelayMs}ms`
  );

  pushCheck(
    checks,
    "private_sync_config",
    hasConsistentPrivateSyncConfig(envConfig) ? "pass" : "fail",
    describePrivateSyncConfig(envConfig)
  );

  if (config) {
    const whitelistSeedCount = countWhitelistSeeds(config.whitelist);
    pushCheck(
      checks,
      "whitelist_sources",
      whitelistSeedCount > 0 ? "pass" : "warn",
      `sources=${Array.isArray(config.whitelist?.sources) ? config.whitelist.sources.length : 0} seeds=${whitelistSeedCount}`
    );

    if (mode === "daily_run" || mode === "retry_failed_run") {
      pushCheck(
        checks,
        "production_source_policy",
        whitelistSeedCount > 0 ? "pass" : "warn",
        whitelistSeedCount > 0
          ? "daily production uses whitelist-first discovery"
          : "no whitelist seeds configured, production would fall back to provider discovery"
      );
    }

    if ((mode === "daily_run" || mode === "retry_failed_run") && !hasDiscoveryInputs(envConfig, config.whitelist)) {
      pushCheck(
        checks,
        "discovery_inputs",
        "warn",
        "no whitelist seeds, sample file, or search templates configured"
      );
    } else if (mode === "daily_run" || mode === "retry_failed_run") {
      pushCheck(checks, "discovery_inputs", "pass", "discovery inputs configured");
    }
  }

  if (mode === "publish_only" || mode === "feishu_only") {
    const latestRunFile = await findLatestRunFile({ rootDir });
    pushCheck(
      checks,
      "latest_run_artifact",
      latestRunFile ? "pass" : "fail",
      latestRunFile || `${mode} requires at least one prior run artifact`
    );
  }

  if (mode === "retry_failed_run") {
    const resumeTarget = await findLatestResumeTarget({
      rootDir,
      maximumAttempts: config?.scoring?.maximum_attempts || Number.POSITIVE_INFINITY
    });
    pushCheck(
      checks,
      "retry_resume_target",
      resumeTarget ? "pass" : "fail",
      resumeTarget ? resumeTarget.incident.attempt_run_id : "no resumable failed run found"
    );
  }

  const summary = summarizeChecks(checks);
  return {
    ok: summary.failed === 0,
    mode,
    summary,
    checks
  };
}

function hasDiscoveryInputs(envConfig, whitelistConfig = {}) {
  return Boolean(
    countWhitelistSeeds(whitelistConfig) ||
      envConfig.discoveryProviderSampleFile ||
      envConfig.discoveryProviderSearchTemplates.length
  );
}

function hasConsistentPrivateSyncConfig(envConfig) {
  const hasPat = Boolean(envConfig.privateDataRepoPat);
  const hasRepo = Boolean(envConfig.privateDataRepo);
  return hasPat === hasRepo;
}

function describePrivateSyncConfig(envConfig) {
  if (!envConfig.privateDataRepoPat && !envConfig.privateDataRepo) {
    return "disabled";
  }

  if (!hasConsistentPrivateSyncConfig(envConfig)) {
    return "PRIVATE_DATA_REPO_PAT and PRIVATE_DATA_REPO must be set together";
  }

  return `${envConfig.privateDataRepo}@${envConfig.privateDataRepoBranch}`;
}

function countWhitelistSeeds(whitelistConfig) {
  return (whitelistConfig?.sources || []).reduce(
    (count, source) => count + (Array.isArray(source.seed_urls) ? source.seed_urls.length : 0),
    0
  );
}

function summarizeChecks(checks) {
  return checks.reduce(
    (summary, check) => {
      if (check.status === "pass") {
        summary.passed += 1;
      } else if (check.status === "warn") {
        summary.warned += 1;
      } else {
        summary.failed += 1;
      }
      return summary;
    },
    { passed: 0, warned: 0, failed: 0 }
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushCheck(checks, name, status, detail) {
  checks.push({ name, status, detail });
}
