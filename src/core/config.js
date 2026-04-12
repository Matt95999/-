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

export function loadEnvConfig(env = process.env) {
  return {
    deepseekApiKey: env.DEEPSEEK_API_KEY || "",
    feishuWebhookUrl: env.FEISHU_WEBHOOK_URL || "",
    privateDataRepoPat: env.PRIVATE_DATA_REPO_PAT || "",
    privateDataRepo: env.PRIVATE_DATA_REPO || "",
    publicBaseUrl: env.PUBLIC_BASE_URL || "",
    discoveryProviderSampleFile: env.DISCOVERY_PROVIDER_SAMPLE_FILE || "",
    discoveryProviderSearchTemplates: safeJsonParse(env.DISCOVERY_PROVIDER_SEARCH_TEMPLATES, []),
    discoveryProviderRequestHeaders: safeJsonParse(env.DISCOVERY_PROVIDER_REQUEST_HEADERS, {})
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
