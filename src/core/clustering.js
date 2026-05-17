import { sha256 } from "../utils/hash.js";
import { jaccardSimilarity, truncate, unique } from "../utils/text.js";

export function buildStoryClusters(scrapedCandidates, keywordConfig, registryState) {
  const clusters = [];

  for (const candidate of scrapedCandidates) {
    const cluster = clusters.find((entry) => isSameStory(entry.seed, candidate));
    if (cluster) {
      cluster.articles.push(candidate);
      cluster.seed = chooseSeed(cluster.seed, candidate);
      continue;
    }

    clusters.push({
      seed: candidate,
      articles: [candidate]
    });
  }

  return clusters.map((cluster) => {
    const theme = detectTheme(cluster.articles, keywordConfig);
    const crossLinks = unique(cluster.articles.map((article) => article.url));
    const headline = cluster.seed.title;
    const productIds = unique(cluster.articles.flatMap((article) => article.product_ids || []));
    const subProductIds = unique(cluster.articles.flatMap((article) => article.sub_product_ids || []));
    const vendorIds = unique(cluster.articles.map((article) => article.vendor_id).filter(Boolean));
    const primaryProductId = choosePrimaryProductId(productIds, registryState);
    const primarySubProductId = choosePrimarySubProductId(subProductIds, primaryProductId, registryState);

    return {
      story_id: sha256(`${headline}|${crossLinks[0]}|${primaryProductId || ""}`).slice(0, 12),
      theme,
      articles: sortArticlesByLanguage(cluster.articles),
      headline,
      brief: truncate(cluster.seed.excerpt || cluster.seed.full_text || headline, 180),
      score: 0,
      confidence: average(cluster.articles.map((item) => item.confidence)),
      cross_links: crossLinks,
      vendor_ids: vendorIds,
      product_ids: productIds,
      sub_product_ids: subProductIds,
      primary_product_id: primaryProductId || null,
      primary_sub_product_id: primarySubProductId || null,
      official_source_level: inferOfficialSourceLevel(cluster.articles),
      primary_language: choosePrimaryLanguage(cluster.articles)
    };
  });
}

function isSameStory(left, right) {
  const leftProducts = unique(left.product_ids || []);
  const rightProducts = unique(right.product_ids || []);
  if (leftProducts.length && rightProducts.length && !shareAny(leftProducts, rightProducts)) {
    return false;
  }

  const titleSimilarity = jaccardSimilarity(left.title || "", right.title || "");
  const textSimilarity = jaccardSimilarity(
    `${left.title || ""} ${truncate(left.excerpt || left.full_text || "", 200)}`,
    `${right.title || ""} ${truncate(right.excerpt || right.full_text || "", 200)}`
  );
  return titleSimilarity >= 0.38 || textSimilarity >= 0.42;
}

function chooseSeed(left, right) {
  const leftScore = ((left.language === "zh-CN") ? 1 : 0) + ((left.full_text || "").length / 1000);
  const rightScore = ((right.language === "zh-CN") ? 1 : 0) + ((right.full_text || "").length / 1000);
  return rightScore > leftScore ? right : left;
}

function detectTheme(articles, keywordConfig) {
  const combined = articles
    .map((article) => `${article.title || ""} ${article.excerpt || ""} ${article.full_text || ""}`)
    .join(" ");

  let bestTheme = "其他";
  let bestScore = -1;

  for (const theme of keywordConfig.themes || []) {
    const score = (theme.terms || []).reduce((sum, term) => sum + Number(combined.includes(term)), 0);
    if (score > bestScore) {
      bestTheme = theme.name;
      bestScore = score;
    }
  }

  return bestTheme;
}

function choosePrimaryProductId(productIds, registryState) {
  const products = productIds
    .map((productId) => registryState?.productMap?.get(productId))
    .filter(Boolean)
    .sort((left, right) => comparePriorityTier(left.priority_tier, right.priority_tier));
  return products[0]?.product_id || productIds[0] || null;
}

function choosePrimarySubProductId(subProductIds, primaryProductId, registryState) {
  if (!subProductIds.length || !primaryProductId) {
    return subProductIds[0] || null;
  }

  const product = registryState?.productMap?.get(primaryProductId);
  if (!product) {
    return subProductIds[0] || null;
  }

  for (const subProduct of product.sub_products || []) {
    if (subProductIds.includes(subProduct.sub_product_id)) {
      return subProduct.sub_product_id;
    }
  }
  return subProductIds[0] || null;
}

function comparePriorityTier(left, right) {
  const weights = { p0: 0, p1: 1, candidate: 2, supplement: 3 };
  return (weights[left] ?? 9) - (weights[right] ?? 9);
}

function inferOfficialSourceLevel(articles) {
  const roles = articles.map((article) => article.source_role || "official_news");
  if (roles.some((role) => role === "official_release_notes" || role === "official_docs_changelog")) {
    return "official_release_notes";
  }
  if (roles.some((role) => role === "official_news")) {
    return "official_news";
  }
  if (roles.some((role) => role === "official_github")) {
    return "official_github";
  }
  return "official_research";
}

function sortArticlesByLanguage(articles) {
  return [...articles].sort((left, right) => {
    const leftPriority = left.language === "zh-CN" ? 0 : 1;
    const rightPriority = right.language === "zh-CN" ? 0 : 1;
    return leftPriority - rightPriority;
  });
}

function choosePrimaryLanguage(articles) {
  return articles.some((article) => article.language === "zh-CN") ? "zh-CN" : (articles[0]?.language || "en");
}

function shareAny(left, right) {
  return left.some((item) => right.includes(item));
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
