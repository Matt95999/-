import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildQueries, discoverCandidates, extractDiscoveryEntries } from "../src/providers/discovery.js";
import { parseArticlePage, scrapeCandidates } from "../src/providers/scraper.js";
import { buildStoryClusters } from "../src/core/clustering.js";
import { scoreStoryClusters } from "../src/core/scoring.js";
import { summarizeDailyDigest } from "../src/core/summarizer.js";
import { buildFeishuPayload } from "../src/core/feishu.js";
import { buildCoverageContext, buildCrossProductConnections, groupClustersByProduct } from "../src/core/coverage.js";
import { renderDigestMarkdown } from "../src/renderers/markdown.js";
import { createAttemptRunContext, createRunContext, getAttemptArtifactId } from "../src/core/context.js";
import { loadConfig } from "../src/core/config.js";
import { createLogger } from "../src/utils/logger.js";
import { readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const logger = createLogger("test-run");

test("pipeline builds a coherent digest from sample discovery results", async () => {
  const config = await loadConfig(rootDir);
  config.registryState.sources = [];
  config.registryState.sourceMap = new Map();
  config.whitelist.sources = [];
  const envConfig = {
    discoveryProviderSampleFile: path.join(rootDir, "private-data", "samples", "discovery-results.json"),
    discoveryProviderSearchTemplates: [],
    discoveryProviderRequestHeaders: {},
    deepseekApiKey: "",
    feishuWebhookUrl: "",
    publicBaseUrl: "https://example.com/report"
  };

  const discoveryResult = await discoverCandidates({ rootDir, config, envConfig, logger, mode: "manual_review" });
  const discovered = discoveryResult.candidates;
  assert.ok(discovered.length >= 3);

  const { scrapedCandidates } = await scrapeCandidates(discovered, {
    envConfig,
    logger,
    remediation: {
      allowExcerptOnly: false
    }
  });
  assert.equal(scrapedCandidates.length, 3);

  const clusters = buildStoryClusters(scrapedCandidates, config.keywords, config.registryState);
  const scored = scoreStoryClusters(clusters, {
    scoringConfig: config.scoring,
    registryState: config.registryState,
    keywordConfig: config.keywords
  });
  assert.ok(scored[0].score >= scored[1].score);
  const coverageContext = await buildCoverageContext({
    rootDir,
    scoredClusters: scored,
    sourceRuns: discoveryResult.sourceRuns,
    registryState: config.registryState,
    minimumStoryScore: config.scoring.minimum_story_score
  });
  const productSections = groupClustersByProduct(scored, config.registryState, config.scoring.minimum_story_score);
  const crossProductConnections = buildCrossProductConnections(scored, config.registryState);

  const digest = await summarizeDailyDigest({
    clusters: scored,
    config,
    envConfig,
    remediation: {
      forceLocalSummary: true,
      allowLocalSummaryFallback: true
    },
    logger,
    coverageContext,
    productSections,
    crossProductConnections
  });

  assert.ok(digest.topline_summary.length > 0);
  assert.ok(digest.coverage_board.length > 0);
  assert.ok(digest.story_items.every((item) => item.narrative.length >= 2));

  const feishuPayload = buildFeishuPayload(digest, "https://example.com/report");
  assert.equal(feishuPayload.msg_type, "post");
  assert.ok(
    feishuPayload.content.post.zh_cn.content[0][0].text.includes("头部产品覆盖面板")
  );
});

test("discovery extracts real candidates from html, rss, and json provider payloads", async () => {
  const fixtureDir = path.join(rootDir, "tests", "fixtures");
  const [htmlText, rssText, jsonText] = await Promise.all([
    readFile(path.join(fixtureDir, "discovery-provider-search.html"), "utf8"),
    readFile(path.join(fixtureDir, "discovery-provider-rss.xml"), "utf8"),
    readFile(path.join(fixtureDir, "discovery-provider-json.json"), "utf8")
  ]);

  const htmlEntries = extractDiscoveryEntries({
    resourceUrl: "https://search.example.com/search?q=ai",
    text: htmlText,
    discoverySource: "search-template",
    query: "AI"
  });
  const rssEntries = extractDiscoveryEntries({
    resourceUrl: "https://feed.example.com/rss.xml",
    text: rssText,
    discoverySource: "search-template",
    query: "AI"
  });
  const jsonEntries = extractDiscoveryEntries({
    resourceUrl: "https://api.example.com/news",
    text: jsonText,
    discoverySource: "search-template",
    query: "AI"
  });

  assert.equal(htmlEntries.length, 2);
  assert.equal(rssEntries.length, 2);
  assert.equal(jsonEntries.length, 1);

  assert.equal(
    htmlEntries[0].url,
    "https://mp.weixin.qq.com/s?__biz=MzAwMDAwMDA=&mid=2650000001&idx=1"
  );
  assert.match(htmlEntries[0].title, /OpenAI 发布新模型/);
  assert.equal(
    rssEntries[0].published_at,
    "2026-04-12T09:30:00.000Z"
  );
  assert.equal(
    jsonEntries[0].url,
    "https://mp.weixin.qq.com/s?__biz=MzAwMDAwMDI=&mid=2650000003&idx=1"
  );
  assert.equal(jsonEntries[0].signals.discovery_format, "json");
});

test("discovery query builder can cap provider fan-out for live runs", () => {
  const keywordConfig = {
    themes: [
      {
        name: "模型",
        terms: ["大模型", "推理模型"]
      }
    ],
    query_expansions: ["最新", "发布", "开源"]
  };

  const uncapped = buildQueries(keywordConfig);
  const capped = buildQueries(keywordConfig, 2);

  assert.equal(uncapped.length, 6);
  assert.deepEqual(capped, ["大模型 最新", "大模型 发布"]);
});

test("discovery ignores provider self links in live rss payloads", () => {
  const bingLikeRss = `<?xml version="1.0" encoding="utf-8"?>
  <rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=AI+Agent&amp;format=rss">
    <channel>
      <title>AI Agent - BingNews</title>
      <link>https://www.bing.com/news/search?q=AI+Agent&amp;format=rss</link>
      <item>
        <title>Anthropic launches Claude Managed Agents</title>
        <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fsiliconangle.com%2f2026%2f04%2f08%2fanthropic-launches-claude-managed-agents-speed-ai-agent-development%2f</link>
        <description>Anthropic launched a managed agent service.</description>
        <pubDate>Wed, 08 Apr 2026 17:32:00 GMT</pubDate>
      </item>
    </channel>
  </rss>`;

  const entries = extractDiscoveryEntries({
    resourceUrl: "https://www.bing.com/news/search?q=AI+Agent&format=rss",
    text: bingLikeRss,
    discoverySource: "search-template",
    query: "AI Agent"
  });

  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].url,
    "https://siliconangle.com/2026/04/08/anthropic-launches-claude-managed-agents-speed-ai-agent-development/"
  );
});

test("discovery filters listing pages and keeps article detail urls", () => {
  const html = `
    <html><body>
      <a href="https://example.com/news">News</a>
      <a href="https://example.com/news/model-launch">Model launch</a>
      <a href="https://example.com/blog/archive">Archive</a>
      <a href="https://example.com/blog/subscribe">Subscribe</a>
      <a href="https://example.com/blog/2026/04/platform-update">Platform update</a>
      <a href="https://example.com/blog/page/2">Page 2</a>
    </body></html>`;

  const entries = extractDiscoveryEntries({
    resourceUrl: "https://example.com/blog/",
    text: html,
    discoverySource: "whitelist"
  });

  assert.deepEqual(
    entries.map((entry) => entry.url),
    ["https://example.com/news/model-launch", "https://example.com/blog/2026/04/platform-update"]
  );
});

test("discovery ignores image assets even when urls contain query strings", () => {
  const html = `
    <html><body>
      <a href="https://example.com/news/model-launch">Model launch</a>
      <a href="https://example.com/news/opengraph-image.png?token=123">OpenGraph image</a>
    </body></html>`;

  const entries = extractDiscoveryEntries({
    resourceUrl: "https://example.com/news/",
    text: html,
    discoverySource: "whitelist"
  });

  assert.deepEqual(entries.map((entry) => entry.url), ["https://example.com/news/model-launch"]);
});

test("discovery ignores feed documents and encoded placeholder links", () => {
  const html = `
    <html><body>
      <a href="https://qwenlm.github.io/blog/index.xml">Feed</a>
      <a href="https://qwenlm.github.io/%3Clink%20or%20path%20of%20image%20for%20opengraph%3E">Placeholder image</a>
      <a href="https://qwenlm.github.io/blog/qwen3guard/">Qwen3Guard</a>
    </body></html>`;

  const entries = extractDiscoveryEntries({
    resourceUrl: "https://qwenlm.github.io/blog/",
    text: html,
    discoverySource: "whitelist"
  });

  assert.deepEqual(entries.map((entry) => entry.url), ["https://qwenlm.github.io/blog/qwen3guard/"]);
});

test("discovery infers published_at from human-readable dates in titles", () => {
  const html = `
    <html><body>
      <a href="https://example.com/news/opus-4-7">
        Apr 16, 2026 Introducing Claude Opus 4.7
      </a>
    </body></html>`;

  const entries = extractDiscoveryEntries({
    resourceUrl: "https://example.com/news/",
    text: html,
    discoverySource: "whitelist"
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].published_at, "2026-04-16T00:00:00.000Z");
});

test("discovery infers old changelog dates from url anchors", () => {
  const entries = extractDiscoveryEntries({
    resourceUrl: "https://ai.google.dev/gemini-api/docs/changelog",
    text: `<a href="https://ai.google.dev/gemini-api/docs/changelog#12-13-23">Gemini API release notes</a>`,
    sourceName: "Gemini API Changelog",
    sourceType: "官方文档",
    discoverySource: "registry",
    allowedHosts: ["ai.google.dev"]
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].published_at, "2023-12-13T00:00:00.000Z");
});

test("discovery infers chinese changelog dates", async () => {
  const config = {
    keywords: { themes: [], query_expansions: [] },
    registryState: {
      sources: [
        {
          source_id: "kimi-changelog-test",
          display_name: "Kimi 变更记录",
          source_type: "官方文档",
          source_role: "official_docs_changelog",
          vendor_id: "moonshot",
          product_ids: ["kimi"],
          status: "active",
          enabled: true,
          priority_weight: 1,
          expected_update_cadence: "high",
          allowed_hosts: [],
          seed_urls: [path.join(rootDir, "tests", "fixtures", "kimi-changelog.html")],
          entry_strategy: "inline_changelog",
          include_entry_text_patterns: ["Kimi"],
          max_entries: 3
        }
      ],
      productMap: new Map([["kimi", { product_id: "kimi", display_name: "Kimi", detection_terms: ["Kimi"] }]]),
      activeProducts: []
    },
    scoring: { maximum_attempts: 5 }
  };
  const result = await discoverCandidates({
    rootDir,
    config,
    envConfig: { discoveryProviderRequestHeaders: {} },
    logger,
    mode: "daily_run"
  });

  assert.equal(result.candidates[0].published_at, "2025-11-06T00:00:00.000Z");
});

test("discovery extracts dated card changelog entries instead of navigation", async () => {
  const config = {
    keywords: { themes: [], query_expansions: [] },
    registryState: {
      sources: [
        {
          source_id: "codex-dated-cards-test",
          display_name: "Codex Changelog",
          source_type: "官方开发者文档",
          source_role: "official_docs_changelog",
          vendor_id: "openai",
          product_ids: ["openai_codex"],
          status: "active",
          enabled: true,
          priority_weight: 1,
          expected_update_cadence: "high",
          allowed_hosts: [],
          seed_urls: [path.join(rootDir, "tests", "fixtures", "codex-changelog.html")],
          entry_strategy: "dated_cards",
          include_entry_text_patterns: ["Codex"],
          require_published_at: true,
          max_entries: 3
        }
      ],
      productMap: new Map([["openai_codex", { product_id: "openai_codex", display_name: "Codex", detection_terms: ["Codex"] }]]),
      activeProducts: []
    },
    scoring: { maximum_attempts: 5 }
  };
  const result = await discoverCandidates({
    rootDir,
    config,
    envConfig: { discoveryProviderRequestHeaders: {} },
    logger,
    mode: "daily_run"
  });

  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].title, /Codex CLI/);
  assert.equal(result.candidates[0].published_at, "2026-05-28T00:00:00.000Z");
  assert.doesNotMatch(result.candidates[0].title, /Using Codex/);
});

test("discovery extracts mintlify update changelog entries", async () => {
  const config = {
    keywords: { themes: [], query_expansions: [] },
    registryState: {
      sources: [
        {
          source_id: "claude-code-mintlify-test",
          display_name: "Claude Code Changelog",
          source_type: "官方文档",
          source_role: "official_release_notes",
          vendor_id: "anthropic",
          product_ids: ["claude_code"],
          status: "active",
          enabled: true,
          priority_weight: 1,
          expected_update_cadence: "high",
          allowed_hosts: [],
          seed_urls: [path.join(rootDir, "tests", "fixtures", "claude-code-changelog.html")],
          entry_strategy: "mintlify_updates",
          include_entry_text_patterns: ["Claude Code", "IDE", "CLI"],
          exclude_entry_text_patterns: ["no user-facing changes"],
          require_published_at: true,
          max_entries: 3
        }
      ],
      productMap: new Map([["claude_code", { product_id: "claude_code", display_name: "Claude Code", detection_terms: ["Claude Code"] }]]),
      activeProducts: []
    },
    scoring: { maximum_attempts: 5 }
  };

  const result = await discoverCandidates({
    rootDir,
    config,
    envConfig: { discoveryProviderRequestHeaders: {} },
    logger,
    mode: "daily_run"
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, "Claude Code 2.1.158");
  assert.equal(result.candidates[0].published_at, "2026-05-29T00:00:00.000Z");
});

test("daily discovery uses whitelist-first sources and skips provider search noise", async () => {
  const whitelistLogger = createLogger("test-discovery-whitelist");
  const config = {
    keywords: { themes: [], query_expansions: [] },
    whitelist: {
      sources: [
        {
          name: "Curated Source",
          source_type: "官方博客",
          priority_weight: 1,
          allowed_hosts: ["news.example.com"],
          seed_urls: [path.join(rootDir, "tests", "fixtures", "discovery-provider-search.html")]
        }
      ]
    },
    scoring: { maximum_attempts: 5 }
  };
  const envConfig = {
    discoveryProviderSampleFile: path.join(rootDir, "private-data", "samples", "discovery-results.json"),
    discoveryProviderSearchTemplates: ["https://example.com/search?q={query}"],
    discoveryProviderRequestHeaders: {},
    discoveryProviderMaxQueries: 2
  };

  const discoveryResult = await discoverCandidates({
    rootDir,
    config,
    envConfig,
    logger: whitelistLogger,
    mode: "daily_run"
  });
  const discovered = discoveryResult.candidates;

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].source_name, "Curated Source");
  assert.equal(discovered[0].url, "https://news.example.com/2026/04/12/agent-platform-audit");
});

test("attempt contexts keep retry artifacts isolated", () => {
  const runContext = createRunContext(rootDir);
  const retryContext = createAttemptRunContext(runContext, 3);

  assert.match(getAttemptArtifactId(runContext), /-a1$/);
  assert.match(getAttemptArtifactId(retryContext), /-a3$/);
  assert.notEqual(getAttemptArtifactId(runContext), getAttemptArtifactId(retryContext));
});

test("clustering avoids merging different stories that only share site chrome", () => {
  const keywordConfig = {
    themes: [
      {
        name: "模型与推理",
        terms: ["大模型", "开源"]
      }
    ]
  };

  const candidates = [
    {
      title: "大模型开闭源之争，争的是什么？-36氪",
      excerpt: "这篇文章讨论开闭源路线和模型商业化的分歧。",
      full_text: "36氪导航 登录 搜索 财经 科技 专题 大模型开闭源之争，争的是什么？ 正文开始。",
      url: "https://www.36kr.com/p/2904454830299783",
      confidence: 0.9
    },
    {
      title: "中国移动大模型也来了，运营商们凭什么和OpenAI同场竞技？-36氪",
      excerpt: "这篇文章讨论运营商做行业大模型和算网融合优势。",
      full_text: "36氪导航 登录 搜索 财经 科技 专题 中国移动大模型也来了，运营商们凭什么和OpenAI同场竞技？ 正文开始。",
      url: "https://www.36kr.com/p/2338246675144327",
      confidence: 0.9
    }
  ];

  const clusters = buildStoryClusters(candidates, keywordConfig, { productMap: new Map() });
  assert.equal(clusters.length, 2);
});

test("scoring does not treat far-future parsed dates as fresh updates", () => {
  const futureCluster = {
    story_id: "future",
    headline: "Gemini API Changelog",
    theme: "Gemini",
    confidence: 0.8,
    official_source_level: "official_docs_changelog",
    product_ids: ["gemini"],
    primary_product_id: "gemini",
    articles: [
      {
        title: "Gemini API Changelog",
        excerpt: "Gemini API 更新日志。",
        published_at: "2099-12-13T00:00:00.000Z",
        discovered_at: new Date().toISOString(),
        signals: { source_priority: 1 }
      }
    ]
  };

  const scored = scoreStoryClusters([futureCluster], {
    scoringConfig: {
      weights: {
        recency: 1,
        source_priority: 0,
        keyword_relevance: 0,
        cross_source_repetition: 0,
        story_type: 0,
        interaction_signal: 0,
        official_source_level: 0,
        product_priority: 0
      },
      official_source_levels: { official_docs_changelog: 100 },
      priority_tiers: { p0: 100 },
      first_tier_product_score_threshold: 100,
      first_tier_source_score_threshold: 75
    },
    registryState: {
      productMap: new Map([["gemini", { product_id: "gemini", priority_tier: "p0" }]])
    },
    keywordConfig: { themes: [] }
  });

  assert.equal(scored[0].score_breakdown.recency, 20);
});

test("scoring caps excerpt-only failed official news below high-confidence threshold", () => {
  const cluster = {
    story_id: "excerpt-only",
    headline: "ChatGPT 官方新闻摘要",
    theme: "ChatGPT",
    confidence: 0.6,
    official_source_level: "official_news",
    product_ids: ["chatgpt"],
    primary_product_id: "chatgpt",
    articles: [
      {
        source_id: "openai-chatgpt-newsroom",
        source_role: "official_news",
        title: "ChatGPT update",
        excerpt: "OpenAI RSS 摘要。",
        published_at: new Date().toISOString(),
        signals: { source_priority: 1, evidence_level: "excerpt_only_failed", has_full_text: false }
      }
    ]
  };

  const scored = scoreStoryClusters([cluster], {
    scoringConfig: {
      weights: {
        recency: 0.12,
        source_priority: 0.13,
        keyword_relevance: 0.08,
        cross_source_repetition: 0.07,
        story_type: 0.07,
        interaction_signal: 0.03,
        official_source_level: 0.25,
        product_priority: 0.25
      },
      official_source_levels: { official_news: 75 },
      priority_tiers: { p0: 100 },
      first_tier_product_score_threshold: 100,
      first_tier_source_score_threshold: 75
    },
    registryState: { productMap: new Map([["chatgpt", { priority_tier: "p0" }]]) },
    keywordConfig: { themes: [] }
  });

  assert.ok(scored[0].score <= 54);
  assert.equal(scored[0].score_breakdown.cross_source_repetition, 33.3);
});

test("scoring caps stale official changelog entries below high-confidence threshold", () => {
  const cluster = {
    story_id: "stale",
    headline: "Gemini 旧更新",
    official_source_level: "official_docs_changelog",
    product_ids: ["gemini"],
    primary_product_id: "gemini",
    articles: [
      {
        source_id: "google-gemini-api-changelog",
        source_role: "official_docs_changelog",
        title: "Gemini old changelog",
        excerpt: "旧版本更新。",
        published_at: "2024-03-19T00:00:00.000Z",
        signals: { source_priority: 1, has_full_text: true }
      }
    ]
  };

  const scored = scoreStoryClusters([cluster], {
    scoringConfig: {
      weights: {
        recency: 0.12,
        source_priority: 0.13,
        keyword_relevance: 0.08,
        cross_source_repetition: 0.07,
        story_type: 0.07,
        interaction_signal: 0.03,
        official_source_level: 0.25,
        product_priority: 0.25
      },
      official_source_levels: { official_docs_changelog: 100 },
      priority_tiers: { p0: 100 },
      first_tier_product_score_threshold: 100,
      first_tier_source_score_threshold: 75
    },
    registryState: { productMap: new Map([["gemini", { priority_tier: "p0" }]]) },
    keywordConfig: { themes: [] }
  });

  assert.ok(scored[0].score <= 54);
});

test("scoring caps official updates outside digest age window", () => {
  const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const cluster = {
    story_id: "outside-digest-window",
    headline: "Codex 三周前更新",
    official_source_level: "official_docs_changelog",
    product_ids: ["openai_codex"],
    primary_product_id: "openai_codex",
    articles: [
      {
        source_id: "openai-codex-developers-changelog",
        source_role: "official_docs_changelog",
        title: "Codex old changelog",
        excerpt: "三周前的官方更新。",
        published_at: twentyDaysAgo,
        signals: { source_priority: 1, has_full_text: true }
      }
    ]
  };

  const scored = scoreStoryClusters([cluster], {
    scoringConfig: {
      weights: {
        recency: 0.12,
        source_priority: 0.13,
        keyword_relevance: 0.08,
        cross_source_repetition: 0.07,
        story_type: 0.07,
        interaction_signal: 0.03,
        official_source_level: 0.25,
        product_priority: 0.25
      },
      official_source_levels: { official_docs_changelog: 100 },
      priority_tiers: { p0: 100 },
      maximum_digest_story_age_days: 14,
      first_tier_product_score_threshold: 100,
      first_tier_source_score_threshold: 75
    },
    registryState: { productMap: new Map([["openai_codex", { priority_tier: "p0" }]]) },
    keywordConfig: { themes: [] }
  });

  assert.ok(scored[0].score <= 54);
});

test("scoring counts repetition by unique source, not same-source anchors", () => {
  const cluster = {
    story_id: "same-source",
    headline: "DeepSeek API 更新",
    confidence: 0.8,
    official_source_level: "official_docs_changelog",
    product_ids: ["deepseek"],
    primary_product_id: "deepseek",
    articles: [
      { source_id: "deepseek-api-updates", source_role: "official_docs_changelog", title: "A", published_at: "2026-05-01T00:00:00.000Z", signals: { source_priority: 1 } },
      { source_id: "deepseek-api-updates", source_role: "official_docs_changelog", title: "B", published_at: "2026-05-02T00:00:00.000Z", signals: { source_priority: 1 } },
      { source_id: "deepseek-api-updates", source_role: "official_docs_changelog", title: "C", published_at: "2026-05-03T00:00:00.000Z", signals: { source_priority: 1 } }
    ]
  };
  const scored = scoreStoryClusters([cluster], {
    scoringConfig: {
      weights: {
        recency: 0,
        source_priority: 0,
        keyword_relevance: 0,
        cross_source_repetition: 1,
        story_type: 0,
        interaction_signal: 0,
        official_source_level: 0,
        product_priority: 0
      },
      official_source_levels: { official_docs_changelog: 100 },
      priority_tiers: { p0: 100 },
      first_tier_product_score_threshold: 100,
      first_tier_source_score_threshold: 75
    },
    registryState: { productMap: new Map([["deepseek", { priority_tier: "p0" }]]) },
    keywordConfig: { themes: [] }
  });

  assert.equal(scored[0].score_breakdown.cross_source_repetition, 33.3);
});

test("scraper prefers article-like content blocks over page chrome", () => {
  const html = `
    <html>
      <body>
        <header>登录 注册 收藏 返回顶部</header>
        <main class="page-shell">
          <article class="article-content">
            <h1>智谱发布 GLM-5.1</h1>
            <p>记者：张三</p>
            <p>智谱发布并开源新一代旗舰模型 GLM-5.1，重点提升长程任务能力。</p>
            <p>该模型在 SWE-bench Pro 上实现国产模型首次超越 Opus 4.6。</p>
          </article>
        </main>
        <footer>意见反馈 关于我们</footer>
      </body>
    </html>`;

  const parsed = parseArticlePage(html);
  assert.match(parsed.fullText, /GLM-5\.1/);
  assert.doesNotMatch(parsed.fullText, /返回顶部/);
  assert.doesNotMatch(parsed.fullText, /意见反馈/);
});

test("scraper keeps whitelist excerpt when article fetch fails on first attempt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("forbidden", {
      status: 403,
      headers: { "content-type": "text/plain" }
    });

  try {
    const { scrapedCandidates } = await scrapeCandidates(
      [
        {
          source_name: "OpenAI Newsroom",
          source_type: "官方博客",
          url: "https://openai.com/news/example",
          title: "OpenAI ships example release",
          excerpt: "官方 feed 摘要：发布了新的模型能力与开发者接口。",
          confidence: 0.72,
          signals: {
            discovery_source: "whitelist"
          }
        }
      ],
      {
        envConfig: { discoveryProviderRequestHeaders: {} },
        logger,
        remediation: { allowExcerptOnly: false }
      }
    );

    assert.equal(scrapedCandidates.length, 1);
    assert.equal(scrapedCandidates[0].full_text, null);
    assert.equal(scrapedCandidates[0].excerpt, "官方 feed 摘要：发布了新的模型能力与开发者接口。");
    assert.equal(scrapedCandidates[0].signals.parse_quality, "excerpt_only");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scraper keeps official registry excerpt when article page blocks fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("forbidden", {
      status: 403,
      headers: { "content-type": "text/plain" }
    });

  try {
    const { scrapedCandidates, sourceRuns } = await scrapeCandidates(
      [
        {
          source_id: "openai-chatgpt-newsroom",
          source_name: "OpenAI Newsroom / ChatGPT",
          source_type: "官方新闻",
          url: "https://openai.com/index/chatgpt-example",
          title: "A new ChatGPT capability",
          excerpt: "官方 RSS 摘要：ChatGPT 发布新的产品能力，面向用户开放。",
          confidence: 0.72,
          signals: {
            discovery_source: "registry"
          }
        }
      ],
      {
        envConfig: { discoveryProviderRequestHeaders: {} },
        logger,
        remediation: { allowExcerptOnly: false },
        sourceRuns: [
          {
            source_id: "openai-chatgpt-newsroom",
            product_ids: ["chatgpt"],
            discovery: { status: "success", discovered_count: 1 }
          }
        ]
      }
    );

    assert.equal(scrapedCandidates.length, 1);
    assert.equal(scrapedCandidates[0].full_text, null);
    assert.equal(scrapedCandidates[0].excerpt, "官方 RSS 摘要：ChatGPT 发布新的产品能力，面向用户开放。");
    assert.equal(scrapedCandidates[0].signals.parse_quality, "excerpt_only");
    assert.equal(sourceRuns[0].scrape.scraped_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scraper drops low-quality chrome text and prefers feed excerpt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      `
        <html>
          <head><title>Release b8833 · ggml-org/llama.cpp</title></head>
          <body>
            Skip to content Navigation Menu Toggle navigation
            Search code, repositories, users, issues, pull requests
            Provide feedback Explore our next generation AI systems
            Latest updates from GitHub
          </body>
        </html>
      `,
      {
        status: 200,
        headers: { "content-type": "text/html" }
      }
    );

  try {
    const { scrapedCandidates } = await scrapeCandidates(
      [
        {
          source_name: "llama.cpp Releases",
          source_type: "GitHub Release",
          url: "https://github.com/ggml-org/llama.cpp/releases/tag/b8833",
          title: "Release b8833 · ggml-org/llama.cpp",
          excerpt: "发布说明显示，这次更新提升了推理性能并补充了模型支持。",
          confidence: 0.72,
          signals: {
            discovery_source: "whitelist"
          }
        }
      ],
      {
        envConfig: { discoveryProviderRequestHeaders: {} },
        logger,
        remediation: { allowExcerptOnly: false }
      }
    );

    assert.equal(scrapedCandidates.length, 1);
    assert.equal(scrapedCandidates[0].full_text, "");
    assert.equal(scrapedCandidates[0].excerpt, "发布说明显示，这次更新提升了推理性能并补充了模型支持。");
    assert.equal(scrapedCandidates[0].signals.has_full_text, false);
    assert.equal(scrapedCandidates[0].signals.parse_quality, "excerpt_only");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scraper rejects skip-to-content page chrome and keeps cleaner excerpt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      `
        <html>
          <head><title>Anthropic News</title></head>
          <body>
            Skip to main content Skip to footer Research Economic Futures Commitments Learn News Try Claude
            Product Announcements Introducing Claude Opus 4.7 Apr 16, 2026
            Our latest model, Claude Opus 4.7, is now generally available.
          </body>
        </html>
      `,
      {
        status: 200,
        headers: { "content-type": "text/html" }
      }
    );

  try {
    const { scrapedCandidates } = await scrapeCandidates(
      [
        {
          source_name: "Anthropic News",
          source_type: "官方博客",
          url: "https://www.anthropic.com/news/claude-opus-4-7",
          title: "Introducing Claude Opus 4.7",
          excerpt: "Claude Opus 4.7 已正式发布，重点提升复杂编码、多步任务和视觉场景表现。",
          confidence: 0.75,
          signals: {
            discovery_source: "whitelist"
          }
        }
      ],
      {
        envConfig: { discoveryProviderRequestHeaders: {} },
        logger,
        remediation: { allowExcerptOnly: false }
      }
    );

    assert.equal(scrapedCandidates.length, 1);
    assert.equal(scrapedCandidates[0].full_text, "");
    assert.equal(scrapedCandidates[0].excerpt, "Claude Opus 4.7 已正式发布，重点提升复杂编码、多步任务和视觉场景表现。");
    assert.equal(scrapedCandidates[0].signals.parse_quality, "excerpt_only");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseArticlePage prefers meta description when body is page chrome", () => {
  const html = `
    <html>
      <head>
        <title>Evaluating agents for scientific discovery | Ai2</title>
        <meta name="description" content="Ai2 发布了一套评估 AI 科研代理是否真正推动科学发现的基准与方法。">
      </head>
      <body>
        Skip to main content
        Ai2 Open models Research Latest Papers News Institute About Careers Media center
        Navigation Menu
        Evaluating agents for scientific discovery April 13, 2026 Ai2 Share
        Everyone's building AI science agents. But how do you know if they actually work?
      </body>
    </html>`;

  const parsed = parseArticlePage(html, "https://allenai.org/blog/evaluating-scientific-discovery-agents");

  assert.equal(parsed.excerpt, "Ai2 发布了一套评估 AI 科研代理是否真正推动科学发现的基准与方法。");
});

test("scraper uses domain-specific containers for common production sources", () => {
  const krHtml = `
    <html><body>
      <div class="kr-header-content">登录 搜索 我的关注</div>
      <div class="common-width content articleDetailContent kr-rich-text-wrapper">
        <p>36氪正文第一段。</p>
        <p>36氪正文第二段。</p>
      </div>
    </body></html>`;
  const iheimaHtml = `
    <html><body>
      <div class="main-content">
        <div class="title">标题</div>
        <div class="author">作者栏</div>
        <p>i黑马正文第一段。</p>
        <p>i黑马正文第二段。</p>
        <div class="copyright">转载说明</div>
      </div>
    </body></html>`;
  const sinaHtml = `
    <html><body>
      <div class="top">新浪首页 返回顶部</div>
      <div class="article" id="artibody">
        <p>新浪正文第一段。</p>
        <p>新浪正文第二段。</p>
      </div>
    </body></html>`;
  const sohuHtml = `
    <html><body>
      <div class="article-info">阅读数</div>
      <article class="article" id="mp-editor">
        <p>搜狐正文第一段。</p>
        <p>搜狐正文第二段。</p>
      </article>
    </body></html>`;

  assert.match(parseArticlePage(krHtml, "https://www.36kr.com/p/1").fullText, /36氪正文第一段/);
  assert.doesNotMatch(parseArticlePage(krHtml, "https://www.36kr.com/p/1").fullText, /登录/);
  assert.equal(parseArticlePage(iheimaHtml, "https://www.iheima.com/article-1.html").fullText, "i黑马正文第一段。 i黑马正文第二段。");
  assert.equal(parseArticlePage(sinaHtml, "https://finance.sina.com.cn/test.shtml").fullText, "新浪正文第一段。 新浪正文第二段。");
  assert.equal(parseArticlePage(sohuHtml, "https://www.sohu.com/a/1_1").fullText, "搜狐正文第一段。 搜狐正文第二段。");
});

test("summarizer backfills malformed model output before publishing", async () => {
  const config = await loadConfig(rootDir);
  config.registryState.sources = [];
  config.registryState.sourceMap = new Map();
  config.whitelist.sources = [];
  const envConfig = {
    discoveryProviderSampleFile: path.join(rootDir, "private-data", "samples", "discovery-results.json"),
    discoveryProviderSearchTemplates: [],
    discoveryProviderRequestHeaders: {},
    deepseekApiKey: "test-key",
    feishuWebhookUrl: "",
    publicBaseUrl: "https://example.com/report"
  };

  const discoveryResult = await discoverCandidates({ rootDir, config, envConfig, logger, mode: "manual_review" });
  const { scrapedCandidates } = await scrapeCandidates(discoveryResult.candidates, {
    envConfig,
    logger,
    remediation: {
      allowExcerptOnly: false
    }
  });
  const clusters = scoreStoryClusters(buildStoryClusters(scrapedCandidates, config.keywords, config.registryState), {
    scoringConfig: config.scoring,
    registryState: config.registryState,
    keywordConfig: config.keywords
  });
  const coverageContext = await buildCoverageContext({
    rootDir,
    scoredClusters: clusters,
    sourceRuns: discoveryResult.sourceRuns,
    registryState: config.registryState,
    minimumStoryScore: config.scoring.minimum_story_score
  });
  const productSections = groupClustersByProduct(clusters, config.registryState, config.scoring.minimum_story_score);
  const crossProductConnections = buildCrossProductConnections(clusters, config.registryState);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                daily_brief_title: "模型输出草稿",
                topline_summary: "",
                product_sections: [{ product_id: clusters[0].primary_product_id, title: "ChatGPT", story_ids: [clusters[0].story_id] }],
                story_items: [
                  {
                    story_id: clusters[0].story_id,
                    headline: "",
                    narrative: ["只有一句"],
                    source_links: []
                  }
                ],
                cross_product_connections: [],
                watchlist: []
              })
            }
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );

  try {
    const digest = await summarizeDailyDigest({
      clusters,
      config,
      envConfig,
      remediation: {
        forceLocalSummary: false,
        allowLocalSummaryFallback: false
      },
      logger,
      coverageContext,
      productSections,
      crossProductConnections
    });

    assert.match(digest.daily_brief_title, /头部大模型情报日报/);
    assert.ok(digest.topline_summary.length > 0);
    assert.equal(digest.story_items.length, Math.min(clusters.length, config.scoring.maximum_story_items));
    assert.ok(digest.story_items.every((item) => item.narrative.length >= 2));
    assert.ok(digest.story_items.every((item) => item.source_links.length >= 1));
    assert.ok(digest.product_sections.length >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarizer retries transient deepseek timeout before failing over", async () => {
  const config = await loadConfig(rootDir);
  config.registryState.sources = [];
  config.registryState.sourceMap = new Map();
  config.whitelist.sources = [];
  const envConfig = {
    discoveryProviderSampleFile: path.join(rootDir, "private-data", "samples", "discovery-results.json"),
    discoveryProviderSearchTemplates: [],
    discoveryProviderRequestHeaders: {},
    deepseekApiKey: "test-key",
    deepseekTimeoutMs: 45000,
    deepseekMaxRetries: 2,
    deepseekRetryDelayMs: 1,
    feishuWebhookUrl: "",
    publicBaseUrl: "https://example.com/report"
  };

  const discoveryResult = await discoverCandidates({ rootDir, config, envConfig, logger, mode: "manual_review" });
  const { scrapedCandidates } = await scrapeCandidates(discoveryResult.candidates, {
    envConfig,
    logger,
    remediation: {
      allowExcerptOnly: false
    }
  });
  const clusters = scoreStoryClusters(buildStoryClusters(scrapedCandidates, config.keywords, config.registryState), {
    scoringConfig: config.scoring,
    registryState: config.registryState,
    keywordConfig: config.keywords
  });
  const coverageContext = await buildCoverageContext({
    rootDir,
    scoredClusters: clusters,
    sourceRuns: discoveryResult.sourceRuns,
    registryState: config.registryState,
    minimumStoryScore: config.scoring.minimum_story_score
  });
  const productSections = groupClustersByProduct(clusters, config.registryState, config.scoring.minimum_story_score);
  const crossProductConnections = buildCrossProductConnections(clusters, config.registryState);

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                daily_brief_title: "重试后的模型输出",
                topline_summary: "模型在重试后完成了整体化摘要。",
                product_sections: [
                  {
                    product_id: clusters[0].primary_product_id,
                    title: "ChatGPT",
                    summary: "本轮重点围绕同一主线展开。",
                    story_ids: [clusters[0].story_id]
                  }
                ],
                story_items: [
                  {
                    story_id: clusters[0].story_id,
                    headline: clusters[0].headline,
                    narrative: ["第一句事实。", "第二句事实。"],
                    conclusion: "结论：重试后模型成功返回。",
                    impact: "影响：摘要链路不再因为一次超时直接中断。",
                    source_links: [clusters[0].articles[0].url]
                  }
                ],
                cross_product_connections: ["同一主线在重试后仍能保持结构完整。"],
                watchlist: ["继续关注模型接口稳定性。"]
              })
            }
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  try {
    const digest = await summarizeDailyDigest({
      clusters,
      config,
      envConfig,
      remediation: {
        forceLocalSummary: false,
        allowLocalSummaryFallback: false
      },
      logger,
      coverageContext,
      productSections,
      crossProductConnections
    });

    assert.equal(fetchCalls, 2);
    assert.match(digest.daily_brief_title, /头部大模型情报日报/);
    assert.ok(digest.story_items.length >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarizer enforces unified Chinese format for English-heavy content", async () => {
  const config = {
    scoring: {
      maximum_story_items: 3,
      maximum_watchlist_items: 2,
      minimum_story_score: 55
    }
  };
  const clusters = [
    {
      story_id: "story-ai2-agent",
      theme: "模型与推理",
      score: 72,
      confidence: 0.86,
      headline: "Evaluating agents for scientific discovery | Ai2",
      brief: "Everyone's building AI science agents. But how do you know if they actually work?",
      cross_links: ["https://allenai.org/blog/evaluating-scientific-discovery-agents"],
      primary_product_id: "chatgpt",
      primary_sub_product_id: null,
      product_ids: ["chatgpt"],
      articles: [
        {
          source_name: "Ai2 Blog",
          source_type: "研究机构",
          source_role: "official_research",
          title: "Evaluating agents for scientific discovery | Ai2",
          excerpt: "Everyone's building AI science agents. But how do you know if they actually work?",
          url: "https://allenai.org/blog/evaluating-scientific-discovery-agents",
          language: "en"
        }
      ]
    },
    {
      story_id: "story-llama-release",
      theme: "产品与智能体",
      score: 68,
      confidence: 0.8,
      headline: "Release b8833 · ggml-org/llama.cpp",
      brief: "android libcommon updates and WebGPU compiler warning fixes.",
      cross_links: ["https://github.com/ggml-org/llama.cpp/releases/tag/b8833"],
      primary_product_id: "deepseek",
      primary_sub_product_id: null,
      product_ids: ["deepseek"],
      articles: [
        {
          source_name: "llama.cpp Releases",
          source_type: "GitHub Release",
          source_role: "official_github",
          title: "Release b8833 · ggml-org/llama.cpp",
          excerpt: "android libcommon updates and WebGPU compiler warning fixes.",
          url: "https://github.com/ggml-org/llama.cpp/releases/tag/b8833",
          language: "en"
        }
      ]
    }
  ];
  const coverageContext = {
    coverage_board: [
      { product_id: "chatgpt", display_name: "ChatGPT", status: "has_update", status_label: "有高置信更新", last_known_update_label: "今天" },
      { product_id: "deepseek", display_name: "DeepSeek", status: "has_update", status_label: "有高置信更新", last_known_update_label: "今天" }
    ],
    covered_products: ["chatgpt", "deepseek"],
    missing_products: []
  };
  const productSections = [
    { product_id: "chatgpt", title: "ChatGPT", summary: "ChatGPT 方向有 1 条更新。", story_ids: ["story-ai2-agent"] },
    { product_id: "deepseek", title: "DeepSeek", summary: "DeepSeek 方向有 1 条更新。", story_ids: ["story-llama-release"] }
  ];

  const digest = await summarizeDailyDigest({
    clusters,
    config,
    envConfig: {
      deepseekApiKey: ""
    },
    remediation: {
      forceLocalSummary: true,
      allowLocalSummaryFallback: true
    },
    logger,
    coverageContext,
    productSections,
    crossProductConnections: []
  });
  const markdown = renderDigestMarkdown(digest);

  assert.match(digest.daily_brief_title, /头部大模型情报日报/);
  assert.ok(digest.story_items.every((item) => item.conclusion.startsWith("结论：")));
  assert.ok(digest.story_items.every((item) => item.impact.startsWith("影响：")));
  assert.doesNotMatch(markdown, /Everyone's building|WebGPU compiler warning fixes|AI Agent|Ai2 Blog|Releases/);
});
