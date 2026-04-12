import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCandidates } from "../src/providers/discovery.js";
import { scrapeCandidates } from "../src/providers/scraper.js";
import { buildStoryClusters } from "../src/core/clustering.js";
import { scoreStoryClusters } from "../src/core/scoring.js";
import { summarizeDailyDigest } from "../src/core/summarizer.js";
import { buildFeishuPayload } from "../src/core/feishu.js";
import { loadConfig } from "../src/core/config.js";
import { createLogger } from "../src/utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const logger = createLogger("test-run");

test("pipeline builds a coherent digest from sample discovery results", async () => {
  const config = await loadConfig(rootDir);
  const envConfig = {
    discoveryProviderSampleFile: path.join(rootDir, "private-data", "samples", "discovery-results.json"),
    discoveryProviderSearchTemplates: [],
    discoveryProviderRequestHeaders: {},
    deepseekApiKey: "",
    feishuWebhookUrl: "",
    publicBaseUrl: "https://example.com/report"
  };

  const discovered = await discoverCandidates({ rootDir, config, envConfig, logger });
  assert.ok(discovered.length >= 3);

  const { scrapedCandidates } = await scrapeCandidates(discovered, {
    envConfig,
    logger,
    remediation: {
      allowExcerptOnly: false
    }
  });
  assert.equal(scrapedCandidates.length, 3);

  const clusters = buildStoryClusters(scrapedCandidates, config.keywords);
  const scored = scoreStoryClusters(clusters, {
    scoringConfig: config.scoring,
    whitelistConfig: config.whitelist,
    keywordConfig: config.keywords
  });
  assert.ok(scored[0].score >= scored[1].score);

  const digest = await summarizeDailyDigest({
    clusters: scored,
    config,
    envConfig,
    remediation: {
      forceLocalSummary: true,
      allowLocalSummaryFallback: true
    },
    logger
  });

  assert.ok(digest.topline_summary.includes("AI"));
  assert.ok(digest.connections.length > 0);
  assert.ok(digest.story_items.every((item) => item.narrative.length >= 2));

  const feishuPayload = buildFeishuPayload(digest, "https://example.com/report");
  assert.equal(feishuPayload.msg_type, "post");
  assert.ok(
    feishuPayload.content.post.zh_cn.content[0][0].text.includes("关联关系")
  );
});
