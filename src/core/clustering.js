import { sha256 } from "../utils/hash.js";
import { jaccardSimilarity, truncate, unique } from "../utils/text.js";

export function buildStoryClusters(scrapedCandidates, keywordConfig) {
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
    return {
      story_id: sha256(`${headline}|${crossLinks[0]}`).slice(0, 12),
      theme,
      articles: cluster.articles,
      headline,
      brief: truncate(cluster.seed.excerpt || cluster.seed.full_text || headline, 180),
      score: 0,
      confidence: average(cluster.articles.map((item) => item.confidence)),
      cross_links: crossLinks
    };
  });
}

function isSameStory(left, right) {
  const titleSimilarity = jaccardSimilarity(left.title || "", right.title || "");
  const textSimilarity = jaccardSimilarity(
    `${left.title || ""} ${truncate(left.full_text || left.excerpt || "", 200)}`,
    `${right.title || ""} ${truncate(right.full_text || right.excerpt || "", 200)}`
  );
  return titleSimilarity >= 0.38 || textSimilarity >= 0.42;
}

function chooseSeed(left, right) {
  if ((right.full_text || "").length > (left.full_text || "").length) {
    return right;
  }
  return left;
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

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
