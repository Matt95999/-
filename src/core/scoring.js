import { hoursAgo } from "../utils/time.js";

export function scoreStoryClusters(clusters, { scoringConfig, registryState, keywordConfig, boostKeywords = [] }) {
  const productMap = registryState?.productMap || new Map();
  const maximumDigestStoryAgeDays = Number(scoringConfig.maximum_digest_story_age_days || 14);

  for (const cluster of clusters) {
    const publishedAt = mostRecentPublishedAt(cluster);
    const recency = recencyScore(publishedAt);
    const sourcePriority = Math.min(
      1,
      cluster.articles.reduce((best, article) => Math.max(best, article.signals?.source_priority || 0.6), 0)
    );
    const keywordRelevance = keywordRelevanceScore(cluster, keywordConfig);
    const repetition = crossSourceRepetitionScore(cluster);
    const storyType = storyTypeScore(cluster);
    const interactionSignal = interactionScore(cluster);
    const evidenceQuality = evidenceQualityScore(cluster);
    const officialSourceLevelScore = normalizeScore(
      scoringConfig.official_source_levels?.[cluster.official_source_level || "official_news"] || 75
    );
    const productPriorityScore = normalizeScore(
      determineProductPriorityScore(cluster, productMap, scoringConfig.priority_tiers || {})
    );
    const specialEventBoost = specialEventBoostScore(cluster, boostKeywords, scoringConfig.special_event_boost || 0);
    const isFirstTier =
      determineProductPriorityScore(cluster, productMap, scoringConfig.priority_tiers || {}) >=
        (scoringConfig.first_tier_product_score_threshold || 100) &&
      (scoringConfig.official_source_levels?.[cluster.official_source_level || "official_news"] || 75) >=
        (scoringConfig.first_tier_source_score_threshold || 75) &&
      evidenceQuality >= 0.65 &&
      publishedAt &&
      hoursAgo(publishedAt) <= 48;

    const weights = scoringConfig.weights;
    const weightedScore =
      weights.recency * recency +
      weights.source_priority * sourcePriority +
      weights.keyword_relevance * keywordRelevance +
      weights.cross_source_repetition * repetition +
      weights.story_type * storyType +
      weights.interaction_signal * interactionSignal +
      weights.official_source_level * officialSourceLevelScore +
      weights.product_priority * productPriorityScore;

    cluster.score = capWeakEvidenceScore(
      round(100 * weightedScore + specialEventBoost + (isFirstTier ? 12 : 0)),
      evidenceQuality,
      publishedAt,
      maximumDigestStoryAgeDays
    );
    cluster.score_breakdown = {
      recency: round(100 * recency),
      source_priority: round(100 * sourcePriority),
      keyword_relevance: round(100 * keywordRelevance),
      cross_source_repetition: round(100 * repetition),
      story_type: round(100 * storyType),
      interaction_signal: round(100 * interactionSignal),
      official_source_level_score: round(100 * officialSourceLevelScore),
      product_priority_score: round(100 * productPriorityScore),
      evidence_quality: round(100 * evidenceQuality),
      special_event_boost: specialEventBoost,
      first_tier_boost: isFirstTier ? 12 : 0
    };
    cluster.is_first_tier = isFirstTier;
  }

  return [...clusters].sort(sortScoredClusters);
}

function mostRecentPublishedAt(cluster) {
  const timestamps = cluster.articles
    .map((article) => article.published_at)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));
  if (!timestamps.length) {
    return null;
  }
  return new Date(Math.max(...timestamps)).toISOString();
}

function crossSourceRepetitionScore(cluster) {
  const uniqueSourceIds = new Set();
  const uniqueHosts = new Set();
  for (const article of cluster.articles) {
    if (article.source_id) {
      uniqueSourceIds.add(article.source_id);
      continue;
    }
    try {
      uniqueHosts.add(new URL(article.url).hostname);
    } catch {
      // Ignore malformed URLs; they should not increase cross-source confidence.
    }
  }
  return Math.min(1, Math.max(uniqueSourceIds.size, uniqueHosts.size) / 3);
}

function evidenceQualityScore(cluster) {
  const qualities = cluster.articles.map((article) => {
    const hasPublishedAt = Boolean(article.published_at);
    if (article.signals?.has_full_text && hasPublishedAt) {
      return 1;
    }
    if (article.source_role === "official_docs_changelog" && hasPublishedAt) {
      return 0.85;
    }
    if (article.source_role === "official_release_notes" && hasPublishedAt) {
      return 0.85;
    }
    if (article.signals?.evidence_level === "excerpt_only_failed") {
      return hasPublishedAt ? 0.42 : 0.28;
    }
    if (article.excerpt && hasPublishedAt) {
      return 0.6;
    }
    return 0.25;
  });
  return qualities.length ? Math.max(...qualities) : 0;
}

function capWeakEvidenceScore(score, evidenceQuality, publishedAt, maximumDigestStoryAgeDays) {
  if (!publishedAt) {
    return Math.min(score, 54);
  }
  if (maximumDigestStoryAgeDays > 0 && hoursAgo(publishedAt) > maximumDigestStoryAgeDays * 24) {
    return Math.min(score, 54);
  }
  if (hoursAgo(publishedAt) > 30 * 24) {
    return Math.min(score, 54);
  }
  if (evidenceQuality < 0.45) {
    return Math.min(score, 54);
  }
  if (evidenceQuality < 0.65) {
    return Math.min(score, 68);
  }
  return score;
}

function sortScoredClusters(left, right) {
  if (left.is_first_tier !== right.is_first_tier) {
    return Number(right.is_first_tier) - Number(left.is_first_tier);
  }
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return (right.confidence || 0) - (left.confidence || 0);
}

function recencyScore(isoLike) {
  if (isFarFutureDate(isoLike)) {
    return 0.2;
  }

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

function isFarFutureDate(isoLike) {
  if (!isoLike) {
    return false;
  }
  const timestamp = new Date(isoLike).getTime();
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return timestamp - Date.now() > 86_400_000;
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
  const strongSignals = ["发布", "开源", "融资", "政策", "落地", "芯片", "推理", "Agent", "Release", "launch", "announce", "API"];
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

function determineProductPriorityScore(cluster, productMap, priorityTiers) {
  const tiers = (cluster.product_ids || [])
    .map((productId) => productMap.get(productId)?.priority_tier || "supplement")
    .map((tier) => priorityTiers[tier] || priorityTiers.supplement || 35);
  if (!tiers.length) {
    return priorityTiers.supplement || 35;
  }
  return Math.max(...tiers);
}

function specialEventBoostScore(cluster, boostKeywords, boostValue) {
  if (!boostKeywords.length || !boostValue) {
    return 0;
  }
  const combined = cluster.articles
    .map((article) => `${article.title || ""} ${article.excerpt || ""} ${cluster.theme || ""}`)
    .join(" ")
    .toLowerCase();
  return boostKeywords.some((keyword) => combined.includes(keyword.toLowerCase())) ? boostValue : 0;
}

function normalizeScore(value) {
  return Math.max(0, Math.min(1, Number(value) / 100));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

export function buildTopRankedCandidatesAudit(scoredClusters, limit = 10) {
  return scoredClusters.slice(0, limit).map((cluster) => ({
    story_id: cluster.story_id,
    headline: cluster.headline,
    primary_product_id: cluster.primary_product_id,
    primary_sub_product_id: cluster.primary_sub_product_id,
    score: cluster.score,
    score_breakdown: cluster.score_breakdown,
    latest_published_at: mostRecentPublishedAt(cluster),
    source_links: cluster.cross_links,
    source_names: cluster.articles.map((article) => article.source_name)
  }));
}
