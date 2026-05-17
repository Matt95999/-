import path from "node:path";
import { readText } from "../utils/fs.js";
import { mergeSourceRegistry } from "./source-registry.js";

async function readJsonCompatibleYaml(filePath) {
  const raw = await readText(filePath);
  return JSON.parse(raw);
}

export async function loadConfig(rootDir) {
  const configDir = path.join(rootDir, "config");
  const [keywords, registryOrNull, generatedOrNull, scoring] = await Promise.all([
    readJsonCompatibleYaml(path.join(configDir, "discovery_keywords.yaml")),
    readJsonCompatibleYaml(path.join(configDir, "source_registry.yaml")).catch(() => null),
    readJsonCompatibleYaml(path.join(configDir, "generated_sources.yaml")).catch(() => ({ sources: [] })),
    readJsonCompatibleYaml(path.join(configDir, "scoring_rules.yaml"))
  ]);
  const legacyWhitelist =
    registryOrNull ? null : await readJsonCompatibleYaml(path.join(configDir, "whitelist_sources.yaml")).catch(() => ({ sources: [] }));
  const registry = registryOrNull || adaptLegacyWhitelistToRegistry(legacyWhitelist);
  const generatedSources = generatedOrNull || { sources: [] };

  const registryState = mergeSourceRegistry({ registry, generatedSources });

  return {
    keywords,
    scoring,
    registry,
    generatedSources,
    registryState,
    whitelist: {
      sources: registryState.sources.map((source) => ({
        name: source.display_name,
        source_id: source.source_id,
        source_type: source.source_type,
        source_role: source.source_role,
        vendor_id: source.vendor_id,
        product_ids: source.product_ids,
        priority_weight: source.priority_weight,
        allowed_hosts: source.allowed_hosts,
        include_url_patterns: source.include_url_patterns,
        exclude_url_patterns: source.exclude_url_patterns,
        include_entry_text_patterns: source.include_entry_text_patterns,
        exclude_entry_text_patterns: source.exclude_entry_text_patterns,
        entry_strategy: source.entry_strategy,
        max_entries: source.max_entries,
        seed_urls: source.seed_urls,
        expected_update_cadence: source.expected_update_cadence,
        evaluation_enabled: source.evaluation_enabled,
        enabled: source.enabled,
        status: source.status,
        cooldown_until: source.cooldown_until,
        quarantined: source.quarantined,
        avg_update_interval_days: source.avg_update_interval_days
      }))
    }
  };
}

function adaptLegacyWhitelistToRegistry(whitelist) {
  return {
    products: [],
    sources: (whitelist?.sources || []).map((source, index) => ({
      source_id: source.source_id || `legacy-source-${index + 1}`,
      display_name: source.name || `Legacy Source ${index + 1}`,
      source_type: source.source_type || "官方来源",
      source_role: source.source_role || "official_news",
      vendor_id: source.vendor_id || "",
      product_ids: source.product_ids || [],
      status: source.status || "active",
      priority_weight: source.priority_weight || 0.8,
      expected_update_cadence: source.expected_update_cadence || "medium",
      evaluation_enabled: Boolean(source.evaluation_enabled),
      allowed_hosts: source.allowed_hosts || [],
      seed_urls: source.seed_urls || [],
      include_url_patterns: source.include_url_patterns || [],
      exclude_url_patterns: source.exclude_url_patterns || [],
      include_entry_text_patterns: source.include_entry_text_patterns || [],
      exclude_entry_text_patterns: source.exclude_entry_text_patterns || [],
      entry_strategy: source.entry_strategy || "listing",
      max_entries: source.max_entries || 8
    }))
  };
}

export async function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, ".env");
  try {
    const raw = await readText(envPath);
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = stripQuotes(value);
      }
    }
  } catch {
    return;
  }
}

export function loadEnvConfig(env = process.env) {
  return {
    deepseekApiKey: env.DEEPSEEK_API_KEY || "",
    deepseekTimeoutMs: safePositiveInteger(env.DEEPSEEK_TIMEOUT_MS, 90000),
    deepseekMaxRetries: safePositiveInteger(env.DEEPSEEK_MAX_RETRIES, 2),
    deepseekRetryDelayMs: safePositiveInteger(env.DEEPSEEK_RETRY_DELAY_MS, 1500),
    feishuWebhookUrl: env.FEISHU_WEBHOOK_URL || "",
    privateDataRepoPat: env.PRIVATE_DATA_REPO_PAT || "",
    privateDataRepo: env.PRIVATE_DATA_REPO || "",
    privateDataRepoBranch: env.PRIVATE_DATA_REPO_BRANCH || "main",
    privateDataRepoBasePath: normalizeRepoPath(env.PRIVATE_DATA_REPO_BASE_PATH || ""),
    publicBaseUrl: env.PUBLIC_BASE_URL || "",
    discoveryProviderSampleFile: env.DISCOVERY_PROVIDER_SAMPLE_FILE || "",
    discoveryProviderSearchTemplates: safeJsonParse(env.DISCOVERY_PROVIDER_SEARCH_TEMPLATES, []),
    discoveryProviderRequestHeaders: safeJsonParse(env.DISCOVERY_PROVIDER_REQUEST_HEADERS, {}),
    discoveryProviderMaxQueries: safePositiveInteger(env.DISCOVERY_PROVIDER_MAX_QUERIES, 0)
  };
}

function safeJsonParse(text, fallback) {
  if (!text) {
    return fallback;
  }

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function safePositiveInteger(text, fallback) {
  const value = Number.parseInt(text || "", 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeRepoPath(value) {
  return value.trim().replace(/^\/+|\/+$/g, "");
}
