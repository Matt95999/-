import path from "node:path";
import { readText } from "../utils/fs.js";

async function readJsonCompatibleYaml(filePath) {
  const raw = await readText(filePath);
  return JSON.parse(raw);
}

export async function loadConfig(rootDir) {
  const configDir = path.join(rootDir, "config");
  const [keywords, whitelist, scoring] = await Promise.all([
    readJsonCompatibleYaml(path.join(configDir, "discovery_keywords.yaml")),
    readJsonCompatibleYaml(path.join(configDir, "whitelist_sources.yaml")),
    readJsonCompatibleYaml(path.join(configDir, "scoring_rules.yaml"))
  ]);

  return { keywords, whitelist, scoring };
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
