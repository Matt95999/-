import { StageError } from "./errors.js";
import { extractSentences, parseJsonFromModelText, truncate, unique } from "../utils/text.js";
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
  const topClusters = clusters.slice(0, config.scoring.maximum_story_items);
  const payload = {
    model: "deepseek-chat",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "你是一个AI行业日报编辑。请把输入故事整理成一份整体化日报，必须输出严格JSON。不要输出Markdown。每条重点摘要用2到4句叙述事实，随后给出结论和影响。connections字段要说明多个摘要之间的关联。"
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
            must_keep_overall_narrative: true
          },
          stories: topClusters.map((cluster) => ({
            story_id: cluster.story_id,
            theme: cluster.theme,
            score: cluster.score,
            confidence: cluster.confidence,
            headline: cluster.headline,
            brief: cluster.brief,
            cross_links: cluster.cross_links,
            articles: cluster.articles.map((article) => ({
              title: article.title,
              excerpt: truncate(article.excerpt || article.full_text || "", 260),
              published_at: article.published_at,
              url: article.url
            }))
          }))
        })
      }
    ]
  };

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    signal: createTimeoutSignal(20000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${envConfig.deepseekApiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API failed with status ${response.status}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  return parseJsonFromModelText(text);
}

function summarizeLocally(clusters, config) {
  const selected = clusters.slice(0, config.scoring.maximum_story_items);
  const storyItems = selected.map((cluster) => makeFallbackStoryItem(cluster));

  return {
    daily_brief_title: `AI 情报日报 ${new Date().toISOString().slice(0, 10)}`,
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
      typeof rawDigest?.daily_brief_title === "string" && rawDigest.daily_brief_title.trim()
        ? rawDigest.daily_brief_title.trim()
        : `AI 情报日报 ${new Date().toISOString().slice(0, 10)}`,
    topline_summary:
      typeof rawDigest?.topline_summary === "string" && rawDigest.topline_summary.trim()
        ? rawDigest.topline_summary.trim()
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
  return {
    story_id: cluster.story_id,
    headline:
      typeof item?.headline === "string" && item.headline.trim() ? item.headline.trim() : cluster.headline,
    theme: typeof item?.theme === "string" && item.theme.trim() ? item.theme.trim() : cluster.theme,
    narrative: normalizeNarrative(item?.narrative, cluster),
    conclusion:
      typeof item?.conclusion === "string" && item.conclusion.trim()
        ? item.conclusion.trim()
        : buildConclusion(cluster),
    impact: typeof item?.impact === "string" && item.impact.trim() ? item.impact.trim() : buildImpact(cluster),
    source_links: normalizeSourceLinks(item?.source_links, cluster)
  };
}

function normalizeNarrative(narrative, cluster) {
  const lines = Array.isArray(narrative)
    ? narrative
        .filter((line) => typeof line === "string")
        .map((line) => line.trim())
        .filter(Boolean)
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
    const title =
      typeof section?.title === "string" && section.title.trim() ? section.title.trim() : null;
    const storyIds = Array.isArray(section?.story_ids)
      ? section.story_ids.filter((storyId) => storyMap.has(storyId))
      : [];

    if (!title || !storyIds.length) {
      continue;
    }

    normalized.push({
      title,
      summary:
        typeof section.summary === "string" && section.summary.trim()
          ? section.summary.trim()
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
        .filter(Boolean)
    : [];

  return items.length ? items : fallback;
}

function makeFallbackStoryItem(cluster) {
  return {
    story_id: cluster.story_id,
    headline: cluster.headline,
    theme: cluster.theme,
    narrative: buildNarrative(cluster),
    conclusion: buildConclusion(cluster),
    impact: buildImpact(cluster),
    source_links: normalizeSourceLinks(cluster.cross_links, cluster)
  };
}

function buildNarrative(cluster) {
  const article = cluster.articles[0];
  const text = article.full_text || article.excerpt || article.title;
  const sentences = extractSentences(text, 3);
  if (sentences.length >= 2) {
    return sentences.slice(0, 3);
  }

  return [
    `${cluster.headline}是今天${cluster.theme}方向最值得关注的更新之一。`,
    `${truncate(text, 90)}。`,
    `它之所以重要，在于这条线索同时关联了${Math.max(1, cluster.articles.length)}个来源。`
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
  const headlines = clusters.slice(0, 3).map((cluster) => cluster.headline);
  return `今天的 AI 进展主要集中在${themes.join("、")}。最值得先看的线索包括${headlines.join("、")}，整体上反映出行业正在从单点能力展示，转向更强调推理效率、流程协作和落地节奏。`;
}

function buildConnections(clusters) {
  if (clusters.length < 2) {
    return ["今天的重点线索较少，暂时未形成清晰的跨主题关联。"];
  }

  const connections = [];
  for (let index = 0; index < clusters.length - 1; index += 1) {
    const current = clusters[index];
    const next = clusters[index + 1];
    connections.push(`${current.headline}与${next.headline}都指向同一趋势：${current.theme}正在和${next.theme}形成更紧密的联动。`);
  }
  return connections.slice(0, 4);
}

function buildWatchlist(clusters, config) {
  return clusters
    .slice(0, config.scoring.maximum_watchlist_items)
    .map((cluster) => `${cluster.headline}后续值得继续跟踪，因为它会影响${cluster.theme}的下一阶段节奏。`);
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
