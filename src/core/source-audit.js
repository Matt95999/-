import path from "node:path";
import { discoverCandidates } from "../providers/discovery.js";
import { scrapeCandidates } from "../providers/scraper.js";
import { createLogger } from "../utils/logger.js";
import { ensureDir, listFiles, listJsonFiles, readJson, removeFile, writeJson, writeJsonAtomic } from "../utils/fs.js";
import { nowIso } from "../utils/time.js";
import { deliverSourceAuditSummary } from "./feishu.js";
import { createRunContext } from "./context.js";

const GENERATED_SOURCE_ALLOWED_FIELDS = new Set([
  "source_id",
  "enabled",
  "priority_weight",
  "cooldown_until",
  "degrade_reason",
  "last_auto_action",
  "last_auto_action_at",
  "quarantined",
  "avg_update_interval_days"
]);

export async function runSourceAudit({ rootDir, config, envConfig }) {
  const logger = createLogger(`source-audit-${Date.now()}`);
  const runContext = createRunContext(rootDir);
  const schemaCheck = validateGeneratedSources(config.generatedSources);
  const auditDir = path.join(rootDir, "private-data", "source-audits");
  const sourceHealthDir = path.join(rootDir, "site", "source-health");
  await ensureDir(auditDir);
  await ensureDir(sourceHealthDir);

  const history = await loadRunArtifacts(rootDir);
  const previousAudit = await loadPreviousAudit(auditDir);
  const { candidates, sourceRuns } = await discoverCandidates({
    rootDir,
    config,
    envConfig,
    logger,
    mode: "source_audit"
  });
  const auditCandidates = limitCandidatesPerSource(candidates, 1);
  const scrapeResult = await scrapeCandidates(auditCandidates, {
    envConfig,
    logger,
    remediation: { allowExcerptOnly: true, allowLocalSummaryFallback: true, forceLocalSummary: true, partialPublish: true },
    sourceRuns
  });

  const sourceReports = buildSourceHealthReports({
    history,
    currentSourceRuns: scrapeResult.sourceRuns,
    registryState: config.registryState
  });

  const proposedGeneratedSources = buildGeneratedSourceChanges({
    currentGeneratedSources: config.generatedSources,
    sourceReports,
    registryState: config.registryState
  });

  const safetyGate = evaluateSafetyGate({
    registryState: config.registryState,
    currentGeneratedSources: config.generatedSources,
    proposedGeneratedSources,
    previousAudit
  });

  const summary = buildSourceAuditSummary({
    sourceReports,
    safetyGate,
    schemaCheck,
    registryState: config.registryState
  });

  const auditRecord = {
    kind: "source_audit",
    audited_at: nowIso(),
    schema_check: schemaCheck,
    safety_gate: safetyGate,
    summary,
    source_reports: sourceReports
  };

  const auditFile = path.join(auditDir, `${new Date().toISOString().slice(0, 10)}.json`);
  await writeJson(auditFile, auditRecord);
  await writeJson(path.join(sourceHealthDir, "latest.json"), summary.public_summary);
  await updateSourceHealthHistory(path.join(sourceHealthDir, "history.json"), summary.public_summary);

  let applied = false;
  let snapshotPath = null;
  if (schemaCheck.ok && !safetyGate.paused) {
    snapshotPath = await saveGeneratedSourcesSnapshot(rootDir, config.generatedSources);
    await writeJsonAtomic(path.join(rootDir, "config", "generated_sources.yaml"), proposedGeneratedSources);
    await cleanupGeneratedSourceSnapshots(rootDir);
    applied = true;
  }

  const summaryText = buildSourceAuditSummaryText(summary, safetyGate, schemaCheck);
  await deliverSourceAuditSummary({
    summaryText,
    envConfig,
    runContext,
    logger
  }).catch((error) => {
    logger.warn("source audit feishu delivery failed", { error: error.message });
  });

  return {
    ok: schemaCheck.ok,
    paused: safetyGate.paused,
    applied,
    snapshotPath,
    auditFile,
    sourceReports,
    summary,
    safetyGate
  };
}

export function runSourceRefresh({ config }) {
  const productSummary = (config.registryState.activeProducts || []).map((product) => {
    const enabledSources = (config.registryState.sources || []).filter(
      (source) => source.enabled && (source.product_ids || []).includes(product.product_id)
    );
    return {
      product_id: product.product_id,
      display_name: product.display_name,
      enabled_source_count: enabledSources.length,
      sources: enabledSources.map((source) => ({
        source_id: source.source_id,
        display_name: source.display_name,
        source_role: source.source_role,
        priority_weight: source.priority_weight
      }))
    };
  });

  return {
    refreshed_at: nowIso(),
    active_products: productSummary
  };
}

export function validateGeneratedSources(generatedSources) {
  const errors = [];
  for (const entry of generatedSources.sources || []) {
    if (!entry?.source_id) {
      errors.push("generated source entry missing source_id");
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!GENERATED_SOURCE_ALLOWED_FIELDS.has(key)) {
        errors.push(`generated source ${entry.source_id} contains illegal field ${key}`);
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors
  };
}

function buildSourceHealthReports({ history, currentSourceRuns, registryState }) {
  const historyBySource = new Map();

  for (const runArtifact of history) {
    for (const sourceRun of runArtifact.sourceRuns || []) {
      if (!historyBySource.has(sourceRun.source_id)) {
        historyBySource.set(sourceRun.source_id, []);
      }
      historyBySource.get(sourceRun.source_id).push(sourceRun);
    }
  }

  for (const sourceRun of currentSourceRuns || []) {
    if (!historyBySource.has(sourceRun.source_id)) {
      historyBySource.set(sourceRun.source_id, []);
    }
    historyBySource.get(sourceRun.source_id).push(sourceRun);
  }

  return (registryState.sources || []).map((source) => {
    const observations = historyBySource.get(source.source_id) || [];
    const avgInterval = estimateAverageUpdateIntervalDays(source, observations);
    const windowDays = computeWindowDays(source, avgInterval);
    const report = makeSourceReport(source, observations, windowDays, avgInterval);
    return report;
  });
}

function makeSourceReport(source, observations, windowDays, avgInterval) {
  const total = observations.length || 1;
  const discoverySuccess = observations.filter((item) => item.discovery?.status !== "failed").length;
  const consecutiveDiscoveryFailures = countTrailingFailures(observations, (item) => item.discovery?.status === "failed");
  const consecutiveScrapeFailures = countTrailingFailures(
    observations.filter((item) => item.discovery?.discovered_count > 0),
    (item) => item.scrape?.status === "failed"
  );
  const discoveredCount = observations.reduce((sum, item) => sum + (item.discovery?.discovered_count || 0), 0);
  const scrapedCount = observations.reduce((sum, item) => sum + (item.scrape?.scraped_count || 0), 0);
  const excerptOnlyCount = observations.reduce((sum, item) => sum + (item.scrape?.excerpt_only_count || 0), 0);
  const failedCount = observations.reduce((sum, item) => sum + (item.scrape?.failed_count || 0), 0);
  const uniqueContribution = estimateUniqueContribution(source.source_id, observations);
  const duplicateRate = 1 - uniqueContribution.rate;
  const noiseRate = observedNoiseRate(observations);
  const stalenessDays = observedStalenessDays(observations);

  const report = {
    source_id: source.source_id,
    product_id: source.product_ids?.[0] || "",
    observation_count: observations.length,
    window_days: windowDays,
    avg_update_interval_days: avgInterval,
    discovery_success_rate: roundRate(discoverySuccess / total),
    scrape_success_rate: roundRate(discoveredCount ? scrapedCount / discoveredCount : 1),
    unique_story_contribution_rate: roundRate(uniqueContribution.rate),
    duplicate_rate: roundRate(duplicateRate),
    fallback_rate: roundRate(scrapedCount ? excerptOnlyCount / scrapedCount : 0),
    staleness_days: stalenessDays,
    noise_rate: roundRate(noiseRate),
    consecutive_discovery_failures: consecutiveDiscoveryFailures,
    consecutive_scrape_failures: consecutiveScrapeFailures,
    health_score: 0,
    recommended_action: "keep",
    source_role: source.source_role,
    status: source.status
  };

  report.health_score = computeHealthScore(report);
  report.recommended_action = recommendAction(source, report);
  return report;
}

function computeHealthScore(report) {
  const freshnessScore = report.staleness_days <= report.window_days ? 1 : Math.max(0.1, 1 - (report.staleness_days - report.window_days) / 30);
  const lowNoiseScore = Math.max(0, 1 - report.noise_rate);
  const lowFallbackScore = Math.max(0, 1 - report.fallback_rate);
  const score =
    100 *
    (0.25 * report.discovery_success_rate +
      0.25 * report.scrape_success_rate +
      0.15 * report.unique_story_contribution_rate +
      0.15 * freshnessScore +
      0.1 * lowNoiseScore +
      0.1 * lowFallbackScore);
  return Math.round(score);
}

function recommendAction(source, report) {
  if (report.noise_rate > 0.3) {
    return "quarantine";
  }
  if (report.consecutive_discovery_failures >= 3 || report.discovery_success_rate < 0.4) {
    return "disable_discovery";
  }
  if (report.consecutive_scrape_failures >= 3 || report.scrape_success_rate < 0.4) {
    return "cooldown";
  }
  if (report.observation_count >= 3 && report.unique_story_contribution_rate < 0.1 && report.duplicate_rate > 0.8) {
    return "deprioritize";
  }
  if (source.status === "candidate" && source.evaluation_enabled && report.health_score >= 75 && report.noise_rate < 0.2) {
    return "promote_candidate";
  }
  return "keep";
}

function buildGeneratedSourceChanges({ currentGeneratedSources, sourceReports, registryState }) {
  const overrides = new Map(
    (currentGeneratedSources.sources || []).map((entry) => [entry.source_id, { ...entry }])
  );
  const now = nowIso();

  for (const report of sourceReports) {
    const source = registryState.sourceMap.get(report.source_id);
    if (!source) {
      continue;
    }
    const existing = overrides.get(report.source_id) || null;
    const next = existing ? { ...existing } : { source_id: report.source_id };
    let changed = Boolean(existing);

    switch (report.recommended_action) {
      case "quarantine":
        next.quarantined = true;
        next.enabled = false;
        next.degrade_reason = "noise_rate";
        next.last_auto_action = "quarantine";
        next.last_auto_action_at = now;
        next.avg_update_interval_days = report.avg_update_interval_days;
        changed = true;
        break;
      case "disable_discovery":
        next.enabled = false;
        next.degrade_reason = "discovery_failure";
        next.last_auto_action = "disable";
        next.last_auto_action_at = now;
        next.avg_update_interval_days = report.avg_update_interval_days;
        changed = true;
        break;
      case "cooldown":
        next.priority_weight = Math.max(0.2, Number(source.priority_weight || 0.8) - 0.2);
        next.cooldown_until = addDaysIso(7);
        next.degrade_reason = "scrape_failure";
        next.last_auto_action = "cooldown";
        next.last_auto_action_at = now;
        next.avg_update_interval_days = report.avg_update_interval_days;
        changed = true;
        break;
      case "deprioritize":
        next.priority_weight = Math.max(0.2, Number(source.priority_weight || 0.8) - 0.1);
        next.degrade_reason = "duplicate_rate";
        next.last_auto_action = "deprioritize";
        next.last_auto_action_at = now;
        next.avg_update_interval_days = report.avg_update_interval_days;
        changed = true;
        break;
      case "promote_candidate":
        next.enabled = true;
        next.quarantined = false;
        next.cooldown_until = "";
        next.degrade_reason = "";
        next.last_auto_action = "promote_candidate";
        next.last_auto_action_at = now;
        next.avg_update_interval_days = report.avg_update_interval_days;
        changed = true;
        break;
      default:
        if (existing && !("enabled" in next) && source.status === "active") {
          next.enabled = true;
        }
        break;
    }
    if (changed) {
      overrides.set(report.source_id, next);
    }
  }

  return {
    sources: [...overrides.values()].sort((left, right) => left.source_id.localeCompare(right.source_id))
  };
}

function evaluateSafetyGate({ registryState, currentGeneratedSources, proposedGeneratedSources, previousAudit }) {
  const currentDisabledCount = (currentGeneratedSources.sources || []).filter((entry) => entry.enabled === false).length;
  const nextDisabledCount = (proposedGeneratedSources.sources || []).filter((entry) => entry.enabled === false).length;
  const newQuarantinedCount = (proposedGeneratedSources.sources || []).filter(
    (entry) => entry.quarantined && !(currentGeneratedSources.sources || []).find((current) => current.source_id === entry.source_id && current.quarantined)
  ).length;
  const changedEntries = countChangedGeneratedSources(currentGeneratedSources, proposedGeneratedSources);
  const currentEntryCount = (currentGeneratedSources.sources || []).length;
  const allowedChangeThreshold = currentEntryCount === 0 ? 10 : Math.max(1, currentEntryCount * 0.5);
  const activeProductOutages = countActiveProductOutages(registryState, proposedGeneratedSources);

  const reasons = [];
  if (previousAudit && nextDisabledCount > Math.max(1, (previousAudit.summary?.disabled_source_count || currentDisabledCount)) * 3) {
    reasons.push("disabled_count_spike");
  }
  if (activeProductOutages.length) {
    reasons.push("active_product_outage");
  }
  if (changedEntries > allowedChangeThreshold) {
    reasons.push("generated_sources_change_volume");
  }
  if (newQuarantinedCount >= 5) {
    reasons.push("quarantine_spike");
  }

  return {
    paused: reasons.length > 0,
    reasons,
    disabled_source_count: nextDisabledCount,
    active_product_outages: activeProductOutages,
    changed_entry_count: changedEntries,
    new_quarantined_count: newQuarantinedCount
  };
}

function buildSourceAuditSummary({ sourceReports, safetyGate, schemaCheck, registryState }) {
  const healthy = sourceReports.filter((report) => report.health_score >= 75).length;
  const thinProducts = (registryState.activeProducts || []).filter((product) => {
    const productReports = sourceReports.filter((report) => report.product_id === product.product_id && report.recommended_action !== "disable_discovery");
    return productReports.length < 1;
  });
  const publicSummary = {
    generated_at: nowIso(),
    healthy_source_count: healthy,
    disabled_source_count: sourceReports.filter((report) => report.recommended_action === "disable_discovery").length,
    product_statuses: (registryState.activeProducts || []).map((product) => ({
      product_id: product.product_id,
      display_name: product.display_name,
      enabled_source_count: sourceReports.filter((report) => report.product_id === product.product_id && report.recommended_action !== "disable_discovery").length,
      status: thinProducts.some((item) => item.product_id === product.product_id) ? "thin" : "healthy"
    })),
    safety_gate: safetyGate,
    schema_check: schemaCheck
  };

  return {
    disabled_source_count: publicSummary.disabled_source_count,
    thin_product_count: thinProducts.length,
    public_summary: publicSummary
  };
}

function buildSourceAuditSummaryText(summary, safetyGate, schemaCheck) {
  const lines = [
    "来源审计结果",
    `生成时间：${nowIso()}`,
    `Schema 校验：${schemaCheck.ok ? "通过" : "失败"}`,
    `停用来源数：${summary.disabled_source_count}`,
    `薄弱产品线数：${summary.thin_product_count}`
  ];

  if (safetyGate.paused) {
    lines.push(`安全门：已暂停自动变更（${safetyGate.reasons.join("、")}）`);
  } else {
    lines.push("安全门：通过");
  }

  return lines.join("\n");
}

async function loadRunArtifacts(rootDir) {
  const files = await listJsonFiles(path.join(rootDir, "private-data", "runs"));
  const history = [];
  for (const file of files.slice(0, 30)) {
    try {
      history.push(await readJson(file.fullPath));
    } catch {
      continue;
    }
  }
  return history;
}

async function loadPreviousAudit(auditDir) {
  const files = await listJsonFiles(auditDir);
  if (!files.length) {
    return null;
  }
  try {
    return await readJson(files[0].fullPath);
  } catch {
    return null;
  }
}

function estimateAverageUpdateIntervalDays(source, observations) {
  const defaultDays = source.source_role === "official_release_notes" || source.source_role === "official_docs_changelog" ? 14 : 7;
  const timestamps = observations
    .map((item) => item.discovery?.last_scanned_at || item.scrape?.last_scraped_at)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (timestamps.length < 2) {
    return defaultDays;
  }
  const gaps = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    gaps.push((timestamps[index] - timestamps[index - 1]) / 86_400_000);
  }
  const average = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  return Math.max(1, Math.round(average));
}

function computeWindowDays(source, avgUpdateIntervalDays) {
  if (source.source_role === "official_release_notes" || source.source_role === "official_docs_changelog") {
    return Math.max(7, Math.ceil(avgUpdateIntervalDays * 2));
  }
  return Math.max(7, Math.ceil(avgUpdateIntervalDays * 1.5));
}

function countTrailingFailures(values, predicate) {
  let failures = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (!predicate(values[index])) {
      break;
    }
    failures += 1;
  }
  return failures;
}

function estimateUniqueContribution(sourceId, observations) {
  let total = 0;
  let uniqueCount = 0;
  for (const observation of observations) {
    total += observation.discovery?.discovered_count || 0;
    if ((observation.discovery?.discovered_count || 0) > 0 && (observation.discovery?.discovered_count || 0) <= 2) {
      uniqueCount += 1;
    }
  }
  return {
    rate: total ? Math.min(1, uniqueCount / total) : 0
  };
}

function observedNoiseRate(observations) {
  const lowQuality = observations.reduce((sum, item) => sum + (item.scrape?.low_quality_count || 0), 0);
  const total = observations.reduce((sum, item) => sum + (item.scrape?.scraped_count || 0), 0);
  return total ? lowQuality / total : 0;
}

function observedStalenessDays(observations) {
  const timestamps = observations
    .map((item) => item.scrape?.last_scraped_at || item.discovery?.last_scanned_at)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) {
    return 365;
  }
  const latest = Math.max(...timestamps);
  return Math.max(0, Math.floor((Date.now() - latest) / 86_400_000));
}

async function saveGeneratedSourcesSnapshot(rootDir, generatedSources) {
  const snapshotPath = path.join(
    rootDir,
    "config",
    `generated_sources.snapshot.${new Date().toISOString().replace(/[:]/g, "-")}.yaml`
  );
  await writeJson(snapshotPath, generatedSources);
  return snapshotPath;
}

async function cleanupGeneratedSourceSnapshots(rootDir) {
  const files = await listFiles(path.join(rootDir, "config"), (entry) => entry.startsWith("generated_sources.snapshot.") && entry.endsWith(".yaml"));
  for (const file of files.slice(3)) {
    await removeFile(file.fullPath);
  }
}

async function updateSourceHealthHistory(filePath, latestSummary) {
  let history = [];
  try {
    history = await readJson(filePath);
  } catch {
    history = [];
  }
  history.unshift(latestSummary);
  await writeJson(filePath, history.slice(0, 12));
}

function countChangedGeneratedSources(currentGeneratedSources, proposedGeneratedSources) {
  const current = new Map((currentGeneratedSources.sources || []).map((entry) => [entry.source_id, JSON.stringify(entry)]));
  let changed = 0;
  for (const entry of proposedGeneratedSources.sources || []) {
    if (current.get(entry.source_id) !== JSON.stringify(entry)) {
      changed += 1;
    }
  }
  return changed;
}

function countActiveProductOutages(registryState, proposedGeneratedSources) {
  const overrideMap = new Map((proposedGeneratedSources.sources || []).map((entry) => [entry.source_id, entry]));
  const outages = [];
  for (const product of registryState.activeProducts || []) {
    const sources = (registryState.sources || []).filter((source) => (source.product_ids || []).includes(product.product_id));
    const anyEnabled = sources.some((source) => {
      const override = overrideMap.get(source.source_id);
      if (override && override.quarantined) {
        return false;
      }
      if (override && typeof override.enabled === "boolean") {
        return override.enabled;
      }
      return source.enabled;
    });
    if (!anyEnabled) {
      outages.push(product.product_id);
    }
  }
  return outages;
}

function roundRate(value) {
  return Math.round(value * 1000) / 1000;
}

function addDaysIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function limitCandidatesPerSource(candidates, perSourceLimit) {
  const counts = new Map();
  const selected = [];
  for (const candidate of candidates) {
    const sourceId = candidate.source_id || "unknown-source";
    const count = counts.get(sourceId) || 0;
    if (count >= perSourceLimit) {
      continue;
    }
    counts.set(sourceId, count + 1);
    selected.push(candidate);
  }
  return selected;
}
