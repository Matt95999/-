import { StageError } from "./errors.js";
import { extractSentences, parseJsonFromModelText, truncate, unique } from "../utils/text.js";
import { nowIso } from "../utils/time.js";

export async function summarizeDailyDigest({ clusters, config, envConfig, remediation, logger }) {
  if (!clusters.length) {
    throw new StageError("summarize", "empty_story_clusters", "no story clusters available for summarization");
  }

  if (envConfig.deepseekApiKey && !remediation.forceLocalSummary) {
    try {
      const digest = await summarizeWithDeepSeek({ clusters, config, envConfig });
      validateDigest(digest);
      return digest;
    } catch (error) {
      logger.warn("deepseek summarization failed, using local fallback", { error: error.message });
      if (!remediation.allowLocalSummaryFallback) {
        throw new StageError("summarize", "deepseek_failure", error.message);
      }
    }
  }

  const fallbackDigest = summarizeLocally(clusters, config);
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
  const grouped = groupBy(selected, (cluster) => cluster.theme || "其他");
  const storyItems = selected.map((cluster) => {
    const lead = cluster.articles[0];
    const narrative = buildNarrative(cluster);
    return {
      story_id: cluster.story_id,
      headline: cluster.headline,
      theme: cluster.theme,
      narrative,
      conclusion: buildConclusion(cluster),
      impact: buildImpact(cluster),
      source_links: cluster.cross_links
    };
  });

  const themeSections = Object.entries(grouped).map(([title, themeClusters]) => ({
    title,
    summary: `${title}相关动态在今天共出现${themeClusters.length}条重点线索，主线集中在${themeClusters.map((item) => item.headline).slice(0, 2).join("、")}。`,
    story_ids: themeClusters.map((item) => item.story_id)
  }));

  const connections = buildConnections(selected);
  const watchlist = selected
    .slice(0, config.scoring.maximum_watchlist_items)
    .map((cluster) => `${cluster.headline}后续值得继续跟踪，因为它会影响${cluster.theme}的下一阶段节奏。`);

  return {
    daily_brief_title: `AI 情报日报 ${new Date().toISOString().slice(0, 10)}`,
    topline_summary: buildTopline(selected),
    theme_sections: themeSections,
    story_items: storyItems,
    connections,
    watchlist,
    generated_at: nowIso()
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

function validateDigest(digest) {
  if (!digest?.daily_brief_title || !digest?.topline_summary) {
    throw new Error("digest missing required top-level fields");
  }
  if (!Array.isArray(digest.story_items) || !digest.story_items.length) {
    throw new Error("digest contains no story_items");
  }
  if (!Array.isArray(digest.connections)) {
    throw new Error("digest missing connections");
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
