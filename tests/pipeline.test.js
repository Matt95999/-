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
import { createAttemptRunContext, createRunContext, getAttemptArtifactId } from "../src/core/context.js";
import { loadConfig } from "../src/core/config.js";
import { createLogger } from "../src/utils/logger.js";
import { readFile } from "node:fs/promises";

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

  const discovered = await discoverCandidates({ rootDir, config, envConfig, logger, mode: "manual_review" });
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

  const discovered = await discoverCandidates({
    rootDir,
    config,
    envConfig,
    logger: whitelistLogger,
    mode: "daily_run"
  });

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

  const clusters = buildStoryClusters(candidates, keywordConfig);
  assert.equal(clusters.length, 2);
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
  const envConfig = {
    discoveryProviderSampleFile: path.join(rootDir, "private-data", "samples", "discovery-results.json"),
    discoveryProviderSearchTemplates: [],
    discoveryProviderRequestHeaders: {},
    deepseekApiKey: "test-key",
    feishuWebhookUrl: "",
    publicBaseUrl: "https://example.com/report"
  };

  const discovered = await discoverCandidates({ rootDir, config, envConfig, logger, mode: "manual_review" });
  const { scrapedCandidates } = await scrapeCandidates(discovered, {
    envConfig,
    logger,
    remediation: {
      allowExcerptOnly: false
    }
  });
  const clusters = scoreStoryClusters(buildStoryClusters(scrapedCandidates, config.keywords), {
    scoringConfig: config.scoring,
    whitelistConfig: config.whitelist,
    keywordConfig: config.keywords
  });

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
                theme_sections: [{ title: "模型与推理", story_ids: [clusters[0].story_id] }],
                story_items: [
                  {
                    story_id: clusters[0].story_id,
                    headline: "",
                    narrative: ["只有一句"],
                    source_links: []
                  }
                ],
                connections: [],
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
      logger
    });

    assert.equal(digest.daily_brief_title, "模型输出草稿");
    assert.ok(digest.topline_summary.length > 0);
    assert.equal(digest.story_items.length, Math.min(clusters.length, config.scoring.maximum_story_items));
    assert.ok(digest.story_items.every((item) => item.narrative.length >= 2));
    assert.ok(digest.story_items.every((item) => item.source_links.length >= 1));
    assert.ok(digest.theme_sections.length >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarizer retries transient deepseek timeout before failing over", async () => {
  const config = await loadConfig(rootDir);
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

  const discovered = await discoverCandidates({ rootDir, config, envConfig, logger, mode: "manual_review" });
  const { scrapedCandidates } = await scrapeCandidates(discovered, {
    envConfig,
    logger,
    remediation: {
      allowExcerptOnly: false
    }
  });
  const clusters = scoreStoryClusters(buildStoryClusters(scrapedCandidates, config.keywords), {
    scoringConfig: config.scoring,
    whitelistConfig: config.whitelist,
    keywordConfig: config.keywords
  });

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
                theme_sections: [
                  {
                    title: clusters[0].theme,
                    summary: "本轮重点围绕同一主线展开。",
                    story_ids: [clusters[0].story_id]
                  }
                ],
                story_items: [
                  {
                    story_id: clusters[0].story_id,
                    headline: clusters[0].headline,
                    theme: clusters[0].theme,
                    narrative: ["第一句事实。", "第二句事实。"],
                    conclusion: "结论：重试后模型成功返回。",
                    impact: "影响：摘要链路不再因为一次超时直接中断。",
                    source_links: [clusters[0].articles[0].url]
                  }
                ],
                connections: ["同一主线在重试后仍能保持结构完整。"],
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
      logger
    });

    assert.equal(fetchCalls, 2);
    assert.equal(digest.daily_brief_title, "重试后的模型输出");
    assert.ok(digest.story_items.length >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
