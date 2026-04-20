import { StageError } from "./errors.js";
import { parseJsonFromModelText, truncate, unique } from "../utils/text.js";
import { nowIso } from "../utils/time.js";
import { createTimeoutSignal } from "../utils/http.js";

export async function summarizeDailyDigest({ clusters, config, envConfig, remediation, logger }) {
  if (!clusters.length) {
    throw new StageError("summarize", "empty_story_clusters", "no story clusters available for summarization");
  }

  if (envConfig.deepseekApiKey && !remediation.forceLocalSummary) {
    try {
      const digest = normalizeDigest(await summarizeWithDeepSeek({ clusters, config, envConfig }), clusters, config);
      validateDigest(digest);
      return digest;
    } catch (error) {
      logger.warn("deepseek summarization failed, using local fallback", { error: error.message });
      if (!remediation.allowLocalSummaryFallback) {
        throw new StageError("summarize", "deepseek_failure", error.message);
      }
    }
  }

  const fallbackDigest = normalizeDigest(summarizeLocally(clusters, config), clusters, config);
  validateDigest(fallbackDigest);
  return fallbackDigest;
}

async function summarizeWithDeepSeek({ clusters, config, envConfig }) {
  const maxRetries = Math.max(1, envConfig.deepseekMaxRetries || 1);
  const retryDelayMs = Math.max(0, envConfig.deepseekRetryDelayMs || 0);
  let lastError = null;

  for (let attemptNo = 1; attemptNo <= maxRetries; attemptNo += 1) {
    const payload = buildDeepSeekPayload({
      clusters,
      config,
      attemptNo
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

function buildDeepSeekPayload({ clusters, config, attemptNo }) {
  const storyLimit = Math.max(2, Math.min(5, config.scoring.maximum_story_items) - (attemptNo - 1));
  const excerptLimit = Math.max(100, 180 - (attemptNo - 1) * 40);
  const topClusters = clusters.slice(0, storyLimit);

  return {
    model: "deepseek-chat",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "你是一个中文人工智能行业日报编辑。请把输入故事整理成一份整体化日报，必须输出严格JSON，不要输出Markdown。除模型名、产品名、机构名、项目名、API名、版本号和URL外，所有标题、摘要、结论、影响、关联判断和观察项必须使用简体中文，不得直接复制英文原文句子。每条重点摘要用2到4句中文叙述事实，随后给出结论和影响。connections字段要说明多个摘要之间的关联。"
      },
      {
        role: "user",
        content: JSON.stringify({
          schema_hint: {
            daily_brief_title: "string",
            topline_summary: "string",
            theme_sections: [{ title: "string", summary: "string", story_ids: ["string"] }],
            story_items: [
              {
                story_id: "string",
                headline: "string",
                theme: "string",
                narrative: ["string", "string"],
                conclusion: "string",
                impact: "string",
                source_links: ["string"]
              }
            ],
            connections: ["string"],
            watchlist: ["string"],
            generated_at: "ISO-8601 string"
          },
          constraints: {
            maximum_story_items: config.scoring.maximum_story_items,
            maximum_watchlist_items: config.scoring.maximum_watchlist_items,
            must_keep_fact_and_inference_separate: true,
            must_keep_overall_narrative: true,
            language: "zh-CN",
            output_style: "统一中文日报格式；允许保留必要英文专有名词，但不能出现英文整句或英文段落。",
            required_story_item_format: [
              "事实：2到4句中文，说明发生了什么、涉及谁、有什么关键变化。",
              "结论：1句中文，明确这条消息应如何判断。",
              "影响：1句中文，说明对行业、产品、开发者或用户的影响。",
              "原文：保留链接。"
            ]
          },
          stories: topClusters.map((cluster) => ({
            story_id: cluster.story_id,
            theme: cluster.theme,
            score: cluster.score,
            confidence: cluster.confidence,
            headline: cluster.headline,
            brief: cluster.brief,
            cross_links: cluster.cross_links,
            articles: cluster.articles.slice(0, 3).map((article) => ({
              title: article.title,
              excerpt: truncate(article.excerpt || article.full_text || "", excerptLimit),
              published_at: article.published_at,
              url: article.url
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

function summarizeLocally(clusters, config) {
  const selected = clusters.slice(0, config.scoring.maximum_story_items);
  const storyItems = selected.map((cluster) => makeFallbackStoryItem(cluster));

  return {
    daily_brief_title: `人工智能情报日报 ${new Date().toISOString().slice(0, 10)}`,
    topline_summary: buildTopline(selected),
    theme_sections: buildThemeSectionsFromStories(storyItems),
    story_items: storyItems,
    connections: buildConnections(selected),
    watchlist: buildWatchlist(selected, config),
    generated_at: nowIso()
  };
}

function normalizeDigest(rawDigest, clusters, config) {
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
    daily_brief_title:
      isUsableChineseText(rawDigest?.daily_brief_title)
        ? polishChineseText(rawDigest.daily_brief_title.trim())
        : buildDailyTitle(selected),
    topline_summary:
      isUsableChineseText(rawDigest?.topline_summary)
        ? polishChineseText(rawDigest.topline_summary.trim())
        : buildTopline(selected),
    theme_sections: normalizeThemeSections(rawDigest?.theme_sections, normalizedStoryItems),
    story_items: normalizedStoryItems,
    connections: normalizeStringList(rawDigest?.connections, buildConnections(selected)),
    watchlist: normalizeStringList(rawDigest?.watchlist, buildWatchlist(selected, config)),
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
    theme: isUsableChineseText(item?.theme) ? polishChineseText(item.theme.trim()) : cluster.theme,
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

function normalizeThemeSections(themeSections, storyItems) {
  const storyMap = new Map(storyItems.map((item) => [item.story_id, item]));
  const normalized = [];

  for (const section of Array.isArray(themeSections) ? themeSections : []) {
    const storyIds = Array.isArray(section?.story_ids)
      ? section.story_ids.filter((storyId) => storyMap.has(storyId))
      : [];
    const fallbackTitle = storyIds.length ? storyMap.get(storyIds[0])?.theme : null;
    const title = isUsableChineseText(section?.title) ? polishChineseText(section.title.trim()) : fallbackTitle;

    if (!title || !storyIds.length) {
      continue;
    }

    normalized.push({
      title,
      summary:
        isUsableChineseText(section.summary)
          ? polishChineseText(section.summary.trim())
          : buildThemeSectionSummary(title, storyIds.map((storyId) => storyMap.get(storyId))),
      story_ids: unique(storyIds)
    });
  }

  return normalized.length ? normalized : buildThemeSectionsFromStories(storyItems);
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
    theme: cluster.theme,
    narrative: buildNarrative(cluster),
    conclusion: buildConclusion(cluster),
    impact: buildImpact(cluster),
    source_links: normalizeSourceLinks(cluster.cross_links, cluster)
  };
}

function buildNarrative(cluster) {
  const sourceNames = unique(cluster.articles.map((article) => displaySourceName(article.source_name)).filter(Boolean)).slice(0, 3);
  const focus = inferChineseFocus(cluster);
  const sourceText = sourceNames.length ? `来源包括${sourceNames.join("、")}` : "来源来自已抓取的公开文章";
  const priority = cluster.score >= 60 ? "中高优先级" : "观察级";

  return [
    `${buildChineseHeadline(cluster)}，${sourceText}，主题归入${cluster.theme}。`,
    `这条线索的核心是${focus}，需要重点看它是否改变模型能力、工程部署或产品落地节奏。`,
    `系统将其列为${priority}线索，依据是来源权重、发布时间、主题相关性和重复提及情况。`
  ];
}

function buildConclusion(cluster) {
  if (cluster.score >= 80) {
    return `结论：这不是单点消息，而是可以进入日常跟踪列表的高优先级进展。`;
  }
  if (cluster.score >= 60) {
    return `结论：这是一个值得关注的中高优先级变化，短期内可能继续发酵。`;
  }
  return `结论：这条消息仍有参考价值，但更适合放入观察名单等待后续证据。`;
}

function buildImpact(cluster) {
  return `影响：它会影响${cluster.theme}方向的产品判断、资源投入或市场预期，尤其是在未来一到两周的跟进节奏上。`;
}

function buildTopline(clusters) {
  const themes = unique(clusters.map((cluster) => cluster.theme)).slice(0, 3);
  const headlines = clusters.slice(0, 3).map((cluster) => buildChineseHeadline(cluster));
  return `今天的人工智能进展主要集中在${themes.join("、")}。最值得先看的线索包括${headlines.join("、")}，它们共同反映出行业正在从单点能力展示，转向更强调工程效率、智能体可靠性和真实场景落地。`;
}

function buildConnections(clusters) {
  if (clusters.length < 2) {
    return ["今天的重点线索较少，暂时未形成清晰的跨主题关联。"];
  }

  const connections = [];
  for (let index = 0; index < clusters.length - 1; index += 1) {
    const current = clusters[index];
    const next = clusters[index + 1];
    connections.push(`${buildChineseHeadline(current)}与${buildChineseHeadline(next)}都指向同一趋势：${current.theme}正在和${next.theme}形成更紧密的联动。`);
  }
  return connections.slice(0, 4);
}

function buildWatchlist(clusters, config) {
  return clusters
    .slice(0, config.scoring.maximum_watchlist_items)
    .map((cluster) => `${buildChineseHeadline(cluster)}后续值得继续跟踪，因为它会影响${cluster.theme}的下一阶段节奏。`);
}

function buildThemeSectionsFromStories(storyItems) {
  const grouped = groupBy(storyItems, (story) => story.theme || "其他");
  return Object.entries(grouped).map(([title, stories]) => ({
    title,
    summary: buildThemeSectionSummary(title, stories),
    story_ids: stories.map((story) => story.story_id)
  }));
}

function buildThemeSectionSummary(title, stories) {
  return `${title}相关动态在今天共出现${stories.length}条重点线索，主线集中在${stories
    .map((item) => item.headline)
    .slice(0, 2)
    .join("、")}。`;
}

function buildDailyTitle(clusters) {
  const themes = unique(clusters.map((cluster) => cluster.theme)).slice(0, 2);
  return themes.length
    ? `人工智能情报日报：${themes.join("与")}进展`
    : `人工智能情报日报 ${new Date().toISOString().slice(0, 10)}`;
}

function buildChineseHeadline(cluster) {
  const article = cluster.articles[0] || {};
  const title = String(cluster.headline || article.title || "");
  const lower = title.toLowerCase();
  const project = inferProjectName(article, title);
  const version = inferVersion(title, article.url);

  if (/github release/i.test(article.source_type || "") || /^release\b/i.test(title)) {
    return version ? `${project} 发布 ${version} 版本更新` : `${project} 发布项目版本更新`;
  }

  if (lower.includes("evaluating agents") || lower.includes("scientific discovery")) {
    return "Ai2 发布科学发现智能体评估研究";
  }
  if (lower.includes("wilddet3d")) {
    return "Ai2 发布 WildDet3D 单图 3D 检测模型";
  }
  if (lower.includes("molmoweb")) {
    return "Ai2 发布 MolmoWeb 网页任务自动化智能体";
  }
  if (lower.includes("molmopoint")) {
    return "Ai2 发布 MolmoPoint 视觉定位架构";
  }
  if (lower.includes("molmobot")) {
    return "Ai2 发布 MolmoBot 仿真训练机器人操作模型";
  }
  if (lower.includes("qwen3guard")) {
    return "Qwen 发布 Qwen3Guard 实时安全护栏模型";
  }
  if (lower.includes("olmohybrid")) {
    return "Ai2 发布 OLMoHybrid 混合推理模型研究";
  }

  if (isUsableChineseText(title)) {
    return title;
  }

  const source = displaySourceName(article.source_name || inferSourceFromUrl(article.url) || "重点来源");
  return `${source} 发布${cluster.theme}相关更新`;
}

function inferChineseFocus(cluster) {
  const combined = cluster.articles
    .map((article) => `${article.title || ""} ${article.excerpt || ""} ${article.full_text || ""}`)
    .join(" ")
    .toLowerCase();

  if (combined.includes("llama.cpp") || combined.includes("webgpu") || combined.includes("cuda")) {
    return "本地推理、硬件加速和部署兼容性的持续优化";
  }
  if (combined.includes("vllm") || combined.includes("serving") || combined.includes("transformers")) {
    return "模型服务、推理吞吐和框架兼容性的变化";
  }
  if (combined.includes("3d") || combined.includes("robot") || combined.includes("vision")) {
    return "多模态感知、空间智能或机器人能力的推进";
  }
  if (combined.includes("agent") || combined.includes("scientific discovery") || combined.includes("benchmark")) {
    return "智能体能力评估、任务可靠性和真实场景泛化";
  }
  if (combined.includes("safety") || combined.includes("guardrail") || combined.includes("moderation")) {
    return "模型安全、内容审核和风险控制能力建设";
  }
  if (combined.includes("api") || combined.includes("release") || combined.includes("model")) {
    return "模型能力、开发者接口或工程工具的版本更新";
  }

  return `${cluster.theme}方向的能力变化、工程进展或应用信号`;
}

function inferProjectName(article, title) {
  const sourceName = String(article.source_name || "");
  const releaseMatch = String(title || "").match(/Release\s+[^·]+·\s+([^/]+\/)?([^/\s]+)/i);
  if (releaseMatch?.[2]) {
    return releaseMatch[2];
  }

  try {
    const parsed = new URL(article.url || "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname === "github.com" && segments.length >= 2) {
      return segments[1];
    }
  } catch {
    // Ignore malformed URLs and fall back to source names.
  }

  return sourceName.replace(/\s+Releases$/i, "") || "项目";
}

function inferVersion(title, url) {
  const titleMatch = String(title || "").match(/\b(v?\d+(?:\.\d+){0,3}(?:[-\w.]*)?|b\d{3,})\b/i);
  if (titleMatch?.[1]) {
    return titleMatch[1];
  }

  try {
    const segments = new URL(url || "").pathname.split("/").filter(Boolean);
    const tagIndex = segments.indexOf("tag");
    return tagIndex >= 0 ? segments[tagIndex + 1] || "" : "";
  } catch {
    return "";
  }
}

function inferSourceFromUrl(url) {
  try {
    return new URL(url || "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function displaySourceName(sourceName = "") {
  return String(sourceName || "")
    .replace(/\bNewsroom\b/gi, "官方新闻")
    .replace(/\bNews\b/gi, "新闻")
    .replace(/\bBlog\b/gi, "博客")
    .replace(/\bReleases\b/gi, "发布页")
    .replace(/\s+/g, " ")
    .trim();
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
  if (!Array.isArray(digest.story_items) || !digest.story_items.length) {
    throw new Error("digest contains no story_items");
  }
  if (!Array.isArray(digest.theme_sections) || !digest.theme_sections.length) {
    throw new Error("digest missing theme_sections");
  }
  if (!Array.isArray(digest.connections) || !digest.connections.length) {
    throw new Error("digest missing connections");
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

function groupBy(values, makeKey) {
  const output = {};
  for (const value of values) {
    const key = makeKey(value);
    output[key] ||= [];
    output[key].push(value);
  }
  return output;
}
