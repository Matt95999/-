import { hoursAgo } from "../utils/time.js";

export function scoreStoryClusters(clusters, { scoringConfig, whitelistConfig, keywordConfig }) {
  const whitelistWeights = new Map(
    (whitelistConfig.sources || []).map((source) => [source.name, source.priority_weight || 1])
  );

  for (const cluster of clusters) {
    const representative = cluster.articles[0];
    const recency = recencyScore(representative.published_at || representative.discovered_at);
    const sourcePriority = Math.min(1, cluster.articles.reduce((best, article) => {
      const weight = article.signals?.source_priority || whitelistWeights.get(article.source_name) || 0.6;
      return Math.max(best, weight);
    }, 0));
    const keywordRelevance = keywordRelevanceScore(cluster, keywordConfig);
    const repetition = Math.min(1, cluster.articles.length / 3);
    const storyType = storyTypeScore(cluster);
    const interactionSignal = interactionScore(cluster);

    const weights = scoringConfig.weights;
    cluster.score = round(
      100 *
        (weights.recency * recency +
          weights.source_priority * sourcePriority +
          weights.keyword_relevance * keywordRelevance +
          weights.cross_source_repetition * repetition +
          weights.story_type * storyType +
          weights.interaction_signal * interactionSignal)
    );
  }

  return [...clusters].sort((a, b) => b.score - a.score);
}

function recencyScore(isoLike) {
  const age = hoursAgo(isoLike);
  if (age <= 6) {
    return 1;
  }
  if (age <= 12) {
    return 0.85;
  }
  if (age <= 24) {
    return 0.65;
  }
  if (age <= 48) {
    return 0.4;
  }
  return 0.2;
}

function keywordRelevanceScore(cluster, keywordConfig) {
  const combined = cluster.articles.map((article) => `${article.title} ${article.excerpt || ""}`).join(" ");
  let matches = 0;
  let total = 0;
  for (const theme of keywordConfig.themes || []) {
    for (const term of theme.terms || []) {
      total += 1;
      if (combined.includes(term)) {
        matches += 1;
      }
    }
  }
  return total ? Math.min(1, matches / 4) : 0.5;
}

function storyTypeScore(cluster) {
  const combined = cluster.articles.map((article) => `${article.title} ${article.excerpt || ""}`).join(" ");
  const strongSignals = ["发布", "开源", "融资", "政策", "落地", "芯片", "推理", "Agent"];
  return Math.min(1, strongSignals.reduce((sum, token) => sum + Number(combined.includes(token)), 0) / 4);
}

function interactionScore(cluster) {
  const bestSignal = cluster.articles.reduce((best, article) => {
    return Math.max(best, Number(article.signals?.interaction_signal || 0));
  }, 0);
  if (bestSignal >= 100000) {
    return 1;
  }
  if (bestSignal >= 10000) {
    return 0.8;
  }
  if (bestSignal >= 1000) {
    return 0.6;
  }
  if (bestSignal > 0) {
    return 0.35;
  }
  return 0.15;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
