import { StageError } from "./errors.js";
import { parseJsonFromModelText, truncate, unique } from "../utils/text.js";
import { nowIso } from "../utils/time.js";
import { createTimeoutSignal } from "../utils/http.js";

export async function summarizeDailyDigest({
  clusters,
  config,
  envConfig,
  remediation,
  logger,
  coverageContext,
  productSections,
  crossProductConnections
}) {
  if (!coverageContext?.coverage_board?.length) {
    throw new StageError("summarize", "missing_coverage_context", "coverage board is required for digest generation");
  }

  if (clusters.length && envConfig.deepseekApiKey && !remediation.forceLocalSummary) {
    try {
      const digest = normalizeDigest(
        await summarizeWithDeepSeek({
          clusters,
          config,
          envConfig,
          coverageContext,
          productSections,
          crossProductConnections
        }),
        {
          clusters,
          config,
          coverageContext,
          productSections,
          crossProductConnections
        }
      );
      validateDigest(digest);
      return digest;
    } catch (error) {
      logger.warn("deepseek summarization failed, using local fallback", { error: error.message });
      if (!remediation.allowLocalSummaryFallback) {
        throw new StageError("summarize", "deepseek_failure", error.message);
      }
    }
  }

  const fallbackDigest = normalizeDigest(
    summarizeLocally({
      clusters,
      config,
      coverageContext,
      productSections,
      crossProductConnections
    }),
    {
      clusters,
      config,
      coverageContext,
      productSections,
      crossProductConnections
    }
  );
  validateDigest(fallbackDigest);
  return fallbackDigest;
}

async function summarizeWithDeepSeek({ clusters, config, envConfig, coverageContext, productSections, crossProductConnections }) {
  const maxRetries = Math.max(1, envConfig.deepseekMaxRetries || 1);
  const retryDelayMs = Math.max(0, envConfig.deepseekRetryDelayMs || 0);
  let lastError = null;

  for (let attemptNo = 1; attemptNo <= maxRetries; attemptNo += 1) {
    const payload = buildDeepSeekPayload({
      clusters,
      config,
      attemptNo,
      coverageContext,
      productSections,
      crossProductConnections
    });

    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        signal: createTimeoutSignal(envConfig.deepseekTimeoutMs || 45000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${envConfig.deepseekApiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = new Error(`DeepSeek API failed with status ${response.status}`);
        error.retriable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      return parseJsonFromModelText(text);
    } catch (error) {
      lastError = error;
      if (attemptNo >= maxRetries || !isRetryableDeepSeekError(error)) {
        throw error;
      }
      await delay(retryDelayMs * attemptNo);
    }
  }

  throw lastError || new Error("DeepSeek summarization failed");
}

function buildDeepSeekPayload({ clusters, config, attemptNo, coverageContext, productSections, crossProductConnections }) {
  const storyLimit = Math.max(0, Math.min(6, config.scoring.maximum_story_items) - (attemptNo - 1));
  const excerptLimit = Math.max(100, 220 - (attemptNo - 1) * 40);
  const topClusters = clusters.slice(0, storyLimit);

  return {
    model: "deepseek-chat",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "你是一个中文头部大模型情报日报编辑。请把输入故事整理成一份整体化日报，必须输出严格 JSON，不要输出 Markdown。除模型名、产品名、机构名、项目名、API 名、版本号和 URL 外，所有标题、摘要、结论、影响、关联判断和观察项必须使用简体中文，不得直接复制英文原文句子。日报要先给主线，再按产品线分段，多个摘要之间要形成整体叙事。"
      },
      {
        role: "user",
        content: JSON.stringify({
          schema_hint: {
            daily_brief_title: "string",
            topline_summary: "string",
            product_sections: [{ product_id: "string", title: "string", summary: "string", story_ids: ["string"] }],
            story_items: [
              {
                story_id: "string",
                headline: "string",
                narrative: ["string", "string"],
                conclusion: "string",
                impact: "string",
                source_links: ["string"]
              }
            ],
            cross_product_connections: ["string"],
            watchlist: ["string"],
            generated_at: "ISO-8601 string"
          },
          constraints: {
            language: "zh-CN",
            maximum_story_items: config.scoring.maximum_story_items,
            maximum_watchlist_items: config.scoring.maximum_watchlist_items,
            output_style: "统一中文产品线日报格式；允许保留必要英文专有名词，但不能出现英文整句或英文段落。",
            required_story_item_format: [
              "事实：2到4句中文，说明发生了什么、涉及谁、有什么关键变化。",
              "结论：1句中文，明确这条消息应如何判断。",
              "影响：1句中文，说明对行业、产品、开发者或用户的影响。",
              "原文：保留链接。"
            ]
          },
          coverage_board: coverageContext.coverage_board,
          product_sections: productSections,
          existing_cross_product_connections: crossProductConnections,
          stories: topClusters.map((cluster) => ({
            story_id: cluster.story_id,
            product_ids: cluster.product_ids,
            primary_product_id: cluster.primary_product_id,
            primary_sub_product_id: cluster.primary_sub_product_id,
            headline: cluster.headline,
            theme: cluster.theme,
            score: cluster.score,
            confidence: cluster.confidence,
            brief: cluster.brief,
            cross_links: cluster.cross_links,
            articles: cluster.articles.slice(0, 3).map((article) => ({
              title: article.title,
              excerpt: truncate(article.excerpt || article.full_text || "", excerptLimit),
              published_at: article.published_at,
              url: article.url,
              source_name: article.source_name
            }))
          }))
        })
      }
    ]
  };
}

function isRetryableDeepSeekError(error) {
  return (
    error?.retriable === true ||
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    /timeout/i.test(error?.message || "")
  );
}

function delay(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeLocally({ clusters, config, coverageContext, productSections, crossProductConnections }) {
  const selected = clusters.slice(0, config.scoring.maximum_story_items);
  const storyItems = selected.map((cluster) => makeFallbackStoryItem(cluster));

  return {
    daily_brief_title: buildDailyTitle(),
    topline_summary: buildTopline(coverageContext, selected),
    coverage_board: coverageContext.coverage_board,
    covered_products: coverageContext.covered_products,
    missing_products: coverageContext.missing_products,
    product_sections: buildProductSectionsFromStories(productSections, storyItems),
    story_items: storyItems,
    cross_product_connections: buildCrossProductConnections(selected, crossProductConnections),
    watchlist: buildWatchlist(coverageContext, selected, config),
    generated_at: nowIso()
  };
}

function normalizeDigest(rawDigest, { clusters, config, coverageContext, productSections, crossProductConnections }) {
  const selected = clusters.slice(0, config.scoring.maximum_story_items);
  const clusterById = new Map(selected.map((cluster) => [cluster.story_id, cluster]));
  const normalizedStoryItems = [];
  const seenStoryIds = new Set();

  for (const item of Array.isArray(rawDigest?.story_items) ? rawDigest.story_items : []) {
    const storyId = typeof item?.story_id === "string" ? item.story_id : null;
    const cluster = storyId ? clusterById.get(storyId) : null;
    if (!cluster || seenStoryIds.has(storyId)) {
      continue;
    }
    normalizedStoryItems.push(normalizeStoryItem(item, cluster));
    seenStoryIds.add(storyId);
  }

  for (const cluster of selected) {
    if (seenStoryIds.has(cluster.story_id)) {
      continue;
    }
    normalizedStoryItems.push(makeFallbackStoryItem(cluster));
  }

  return {
    daily_brief_title: buildDailyTitle(),
    topline_summary:
      isUsableChineseText(rawDigest?.topline_summary)
        ? polishChineseText(rawDigest.topline_summary.trim())
        : buildTopline(coverageContext, selected),
    coverage_board: coverageContext.coverage_board,
    covered_products: coverageContext.covered_products,
    missing_products: coverageContext.missing_products,
    product_sections: normalizeProductSections(rawDigest?.product_sections, normalizedStoryItems, productSections),
    story_items: normalizedStoryItems,
    cross_product_connections: normalizeStringList(
      rawDigest?.cross_product_connections,
      buildCrossProductConnections(selected, crossProductConnections)
    ),
    watchlist: normalizeStringList(rawDigest?.watchlist, buildWatchlist(coverageContext, selected, config)),
    generated_at:
      typeof rawDigest?.generated_at === "string" && rawDigest.generated_at.trim()
        ? rawDigest.generated_at.trim()
        : nowIso()
  };
}

function normalizeStoryItem(item, cluster) {
  const headline =
    isUsableChineseText(item?.headline) ? polishChineseText(item.headline.trim()) : buildChineseHeadline(cluster);
  const conclusion = isUsableChineseText(item?.conclusion)
    ? ensurePrefix(polishChineseText(item.conclusion.trim()), "结论：")
    : buildConclusion(cluster);
  const impact = isUsableChineseText(item?.impact)
    ? ensurePrefix(polishChineseText(item.impact.trim()), "影响：")
    : buildImpact(cluster);

  return {
    story_id: cluster.story_id,
    headline,
    narrative: normalizeNarrative(item?.narrative, cluster),
    conclusion,
    impact,
    source_links: normalizeSourceLinks(item?.source_links, cluster)
  };
}

function normalizeNarrative(narrative, cluster) {
  const lines = Array.isArray(narrative)
    ? narrative
        .filter((line) => typeof line === "string")
        .map((line) => line.trim())
        .filter(isUsableChineseText)
        .filter((line) => !/^(结论|影响|原文)[：:]/.test(line))
        .map(polishChineseText)
    : [];

  return lines.length >= 2 ? lines.slice(0, 4) : buildNarrative(cluster);
}

function normalizeSourceLinks(sourceLinks, cluster) {
  const links = Array.isArray(sourceLinks)
    ? sourceLinks
        .filter((link) => typeof link === "string")
        .map((link) => link.trim())
        .filter(Boolean)
    : [];

  if (links.length) {
    return unique(links);
  }

  if (Array.isArray(cluster.cross_links) && cluster.cross_links.length) {
    return unique(cluster.cross_links);
  }

  return cluster.articles.map((article) => article.url).filter(Boolean);
}

function normalizeProductSections(productSections, storyItems, fallbackSections) {
  const storyMap = new Map(storyItems.map((item) => [item.story_id, item]));
  const normalized = [];

  for (const section of Array.isArray(productSections) ? productSections : []) {
    const storyIds = Array.isArray(section?.story_ids)
      ? section.story_ids.filter((storyId) => storyMap.has(storyId))
      : [];
    if (!storyIds.length) {
      continue;
    }

    normalized.push({
      product_id: typeof section.product_id === "string" ? section.product_id : "",
      title: normalizeSectionTitle(section?.title, section?.product_id),
      summary:
        isUsableChineseText(section?.summary)
          ? polishChineseText(section.summary.trim())
          : `今天这一产品线共有 ${storyIds.length} 条重点更新。`,
      story_ids: unique(storyIds),
      sub_sections: Array.isArray(section?.sub_sections) ? section.sub_sections : []
    });
  }

  return normalized.length ? normalized : buildProductSectionsFromStories(fallbackSections, storyItems);
}

function normalizeSectionTitle(title, productId) {
  if (isUsableChineseText(title)) {
    return polishChineseText(title.trim());
  }

  const raw = String(title || "").trim();
  const productName = displayProductName(productId);
  if (!raw || raw.toLowerCase() === String(productId || "").toLowerCase()) {
    return productName;
  }
  return productName || raw || "重点产品线";
}

function normalizeStringList(value, fallback) {
  const items = Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(isUsableChineseText)
        .map(polishChineseText)
    : [];

  return items.length ? items : fallback;
}

function makeFallbackStoryItem(cluster) {
  return {
    story_id: cluster.story_id,
    headline: buildChineseHeadline(cluster),
    narrative: buildNarrative(cluster),
    conclusion: buildConclusion(cluster),
    impact: buildImpact(cluster),
    source_links: normalizeSourceLinks(cluster.cross_links, cluster)
  };
}

function buildNarrative(cluster) {
  const sourceNames = unique(cluster.articles.map((article) => displaySourceName(article.source_name)).filter(Boolean)).slice(0, 3);
  const productName = cluster.primary_product_id || "重点产品";
  const sourceText = sourceNames.length ? `来源包括${sourceNames.join("、")}` : "来源来自已抓取的官方页面";
  const priority = cluster.score >= 80 ? "高优先级" : cluster.score >= 60 ? "中高优先级" : "观察级";

  return [
    `${buildChineseHeadline(cluster)}，${sourceText}，核心归属到 ${displayProductName(productName)}。`,
    `这条更新的重点在于它改变了该产品线的能力、接口、交互方式或落地节奏，需要结合后续几天的连续信号一起看。`,
    `系统把它列为${priority}线索，依据是官方来源等级、产品优先级、发布时间和重复提及情况。`
  ];
}

function buildConclusion(cluster) {
  if (cluster.score >= 80) {
    return "结论：这是一条应进入头部产品跟踪列表的高优先级更新。";
  }
  if (cluster.score >= 60) {
    return "结论：这是一个值得继续观察的中高优先级变化。";
  }
  return "结论：这条消息仍有参考价值，但更适合进入观察名单等待后续确认。";
}

function buildImpact(cluster) {
  const productName = displayProductName(cluster.primary_product_id || "产品线");
  return `影响：它会直接影响 ${productName} 的产品判断、接口使用方式或竞争节奏。`;
}

function buildTopline(coverageContext, clusters) {
  if (!clusters.length) {
    return "今天未发现头部产品线的高置信官方更新，系统已完成扫描，并把缺口与来源状态单独列出，便于后续继续跟踪。";
  }
  const products = unique(clusters.map((cluster) => displayProductName(cluster.primary_product_id)).filter(Boolean)).slice(0, 4);
  const watched = coverageContext.missing_products.filter((item) => item.reason === "source_gap").map((item) => displayProductName(item.product_id));
  const mainline = `今天的高置信更新主要集中在${products.join("、")}。`;
  if (!watched.length) {
    return `${mainline} 整体看，主线不是单一模型发布，而是头部产品在能力迭代、开发者接口和应用层体验上的同步推进。`;
  }
  return `${mainline} 同时，${watched.join("、")}仍存在来源缺口，需要继续关注来源恢复情况。`;
}

function buildCrossProductConnections(clusters, fallbackConnections) {
  if (Array.isArray(fallbackConnections) && fallbackConnections.length) {
    return fallbackConnections.slice(0, 4);
  }
  if (clusters.length < 2) {
    return [];
  }
  const current = clusters[0];
  const next = clusters[1];
  return [
    `${displayProductName(current.primary_product_id)} 与 ${displayProductName(next.primary_product_id)} 的更新都在说明，头部模型产品正在把能力提升和产品化节奏一起前移。`
  ];
}

function buildWatchlist(coverageContext, clusters, config) {
  const watchlist = [];
  for (const item of coverageContext.missing_products.filter((entry) => entry.reason === "source_gap")) {
    watchlist.push(`${displayProductName(item.product_id)} 目前存在来源缺口，后续应优先检查官方入口是否改版或新增可用候选源。`);
  }
  for (const cluster of clusters.slice(0, config.scoring.maximum_watchlist_items)) {
    watchlist.push(`${buildChineseHeadline(cluster)} 后续值得继续跟踪，因为它可能带来后续模型、接口或产品节奏的连续更新。`);
  }
  return unique(watchlist).slice(0, config.scoring.maximum_watchlist_items + 2);
}

function buildProductSectionsFromStories(productSections, storyItems) {
  const storyMap = new Map(storyItems.map((story) => [story.story_id, story]));
  return (productSections || [])
    .map((section) => ({
      product_id: section.product_id,
      title: section.title,
      summary: section.summary,
      story_ids: (section.story_ids || []).filter((storyId) => storyMap.has(storyId)),
      sub_sections: section.sub_sections || []
    }))
    .filter((section) => section.story_ids.length);
}

function buildDailyTitle() {
  return `头部大模型情报日报 ${new Date().toISOString().slice(0, 10)}`;
}

function buildChineseHeadline(cluster) {
  const article = cluster.articles[0] || {};
  const title = String(cluster.headline || article.title || "");
  if (isUsableChineseText(title)) {
    return title;
  }
  return `${displayProductName(cluster.primary_product_id)} 发布新一轮更新`;
}

function displaySourceName(sourceName = "") {
  return String(sourceName || "")
    .replace(/\bNewsroom\b/gi, "官方新闻")
    .replace(/\bNews\b/gi, "新闻")
    .replace(/\bBlog\b/gi, "博客")
    .replace(/\bReleases?\b/gi, "发布页")
    .replace(/\s+/g, " ")
    .trim();
}

function displayProductName(productId = "") {
  const map = {
    chatgpt: "ChatGPT",
    openai_codex: "Codex",
    claude: "Claude",
    claude_code: "Claude Code",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    mistral: "Mistral",
    kimi: "Kimi",
    glm: "GLM"
  };
  return map[productId] || productId || "重点产品线";
}

function polishChineseText(text) {
  return String(text || "")
    .replace(/\bAI Agents?\b/gi, "智能体")
    .replace(/\bAgents?\b/gi, "智能体")
    .replace(/\bAI\b/g, "人工智能")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsableChineseText(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const text = value.trim();
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (chineseChars < 2) {
    return false;
  }
  return !isEnglishDominantText(text, chineseChars);
}

function isEnglishDominantText(text, chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length) {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, "");
  const englishWords = withoutUrls.match(/[A-Za-z][A-Za-z'-]{2,}/g) || [];
  const technicalWords = englishWords.filter((word) => /[A-Z0-9.]/.test(word) || ["api", "sdk", "ai"].includes(word.toLowerCase()));
  const proseWords = englishWords.length - technicalWords.length;
  return proseWords >= 6 && proseWords > chineseChars / 2;
}

function ensurePrefix(text, prefix) {
  return text.startsWith(prefix) ? text : `${prefix}${text}`;
}

function validateDigest(digest) {
  if (!digest?.daily_brief_title || !digest?.topline_summary) {
    throw new Error("digest missing required top-level fields");
  }
  if (!Array.isArray(digest.coverage_board) || !digest.coverage_board.length) {
    throw new Error("digest missing coverage_board");
  }
  if (!Array.isArray(digest.product_sections)) {
    throw new Error("digest missing product_sections");
  }
  if (!Array.isArray(digest.story_items)) {
    throw new Error("digest missing story_items");
  }
  for (const item of digest.story_items) {
    if (!item.story_id || !item.headline) {
      throw new Error("digest contains incomplete story_items");
    }
    if (!Array.isArray(item.narrative) || item.narrative.length < 2) {
      throw new Error("digest contains invalid story narrative");
    }
    if (!Array.isArray(item.source_links) || !item.source_links.length) {
      throw new Error("digest contains story without source_links");
    }
  }
}
