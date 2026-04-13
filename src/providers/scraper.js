import { loadResourceText } from "./resource-loader.js";
import { StageError } from "../core/errors.js";
import { sha256 } from "../utils/hash.js";
import { extractSentences, stripHtml, truncate, unique } from "../utils/text.js";
import { nowIso } from "../utils/time.js";

const CONTENT_CONTAINER_PATTERN = /<(article|main|section|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const CONTENT_HINT_PATTERN = /(article|content|main|post|detail|正文|entry|rich_media|news|story|text|body)/i;
const BOILERPLATE_MARKERS = [
  "登录",
  "注册",
  "收藏",
  "扫一扫",
  "返回顶部",
  "意见反馈",
  "app下载",
  "版权",
  "隐私",
  "关于我们",
  "上一篇",
  "下一篇"
];
const DOMAIN_CONTENT_PATTERNS = [
  {
    hostPattern: /(^|\.)36kr\.com$/i,
    patterns: [/<(div|section)\b[^>]*class=["'][^"']*articleDetailContent[^"']*["'][^>]*>/i]
  },
  {
    hostPattern: /(^|\.)iheima\.com$/i,
    patterns: [/<(div)\b[^>]*class=["'][^"']*main-content[^"']*["'][^>]*>/i],
    transformHtml: (innerHtml) => {
      const contentStart = innerHtml.search(/<p\b/i);
      const cropped = contentStart >= 0 ? innerHtml.slice(contentStart) : innerHtml;
      const contentEndMarkers = [
        /<div\b[^>]*class=["'][^"']*copyright[^"']*["'][^>]*>/i,
        /<div\b[^>]*class=["'][^"']*common-title[^"']*["'][^>]*>/i,
        /<div\b[^>]*class=["'][^"']*block-title[^"']*["'][^>]*>/i
      ];
      let endIndex = cropped.length;
      for (const marker of contentEndMarkers) {
        const match = marker.exec(cropped);
        if (match) {
          endIndex = Math.min(endIndex, match.index);
        }
      }
      return cropped.slice(0, endIndex);
    }
  },
  {
    hostPattern: /(^|\.)sina\.com\.cn$/i,
    patterns: [/<(div)\b[^>]*id=["']artibody["'][^>]*>/i]
  },
  {
    hostPattern: /(^|\.)sohu\.com$/i,
    patterns: [/<(article)\b[^>]*id=["']mp-editor["'][^>]*>/i]
  }
];

export async function scrapeCandidates(candidates, { envConfig, logger, remediation }) {
  const results = [];
  const failures = [];

  for (const candidate of candidates) {
    try {
      const html = await loadResourceText(candidate.url, envConfig.discoveryProviderRequestHeaders);
      const parsed = parseArticlePage(html, candidate.url);
      const fullText = parsed.fullText || candidate.full_text || "";
      const excerpt = candidate.excerpt || parsed.excerpt || truncate(fullText, 180);
      const confidence = computeConfidence(candidate.confidence, parsed, remediation);

      results.push({
        ...candidate,
        title: parsed.title || candidate.title,
        published_at: parsed.publishedAt || candidate.published_at,
        discovered_at: candidate.discovered_at || nowIso(),
        excerpt,
        full_text: fullText || (remediation.allowExcerptOnly ? null : ""),
        signals: {
          ...candidate.signals,
          has_full_text: Boolean(fullText),
          byline: parsed.byline,
          interaction_signal: parsed.interactionSignal
        },
        confidence,
        content_hash: sha256(`${candidate.url}|${parsed.title || candidate.title}|${fullText || excerpt}`)
      });
    } catch (error) {
      logger.warn("scrape failed", { url: candidate.url, error: error.message });
      failures.push({ candidate, reason: error.message });
      if (remediation.allowExcerptOnly && candidate.excerpt) {
        results.push({
          ...candidate,
          full_text: null,
          confidence: Math.max(0.25, candidate.confidence - 0.2),
          signals: {
            ...candidate.signals,
            has_full_text: false,
            scrape_failed: true
          }
        });
      }
    }
  }

  if (!results.length) {
    throw new StageError("scrape", "scrape_failure", "all candidate scraping attempts failed", {
      failureCount: failures.length
    });
  }

  return { scrapedCandidates: results, failures };
}

export function parseArticlePage(html, sourceUrl = "") {
  const fullText = extractReadableText(html, sourceUrl);
  const title =
    extractMeta(html, "property", "og:title") ||
    extractMeta(html, "name", "twitter:title") ||
    extractMeta(html, "name", "title") ||
    extractFirstTag(html, "h1") ||
    extractFirstTag(html, "title") ||
    "";
  const excerpt =
    extractMeta(html, "name", "description") ||
    extractMeta(html, "property", "og:description") ||
    extractSentences(fullText, 2).join(" ");
  const publishedAt =
    extractMeta(html, "property", "article:published_time") ||
    extractMeta(html, "name", "publishdate") ||
    extractIsoLikeDate(fullText);
  const byline = extractMeta(html, "name", "author") || null;
  const interactionSignal = extractInteractionSignal(fullText);

  return {
    title: title.trim(),
    excerpt: excerpt ? excerpt.trim() : null,
    fullText: fullText.trim(),
    publishedAt,
    byline,
    interactionSignal
  };
}

function extractReadableText(html, sourceUrl = "") {
  const domainSpecificText = extractDomainSpecificReadableText(html, sourceUrl);
  if (domainSpecificText) {
    return domainSpecificText;
  }

  const candidates = [];
  let match;

  while ((match = CONTENT_CONTAINER_PATTERN.exec(html)) !== null) {
    if (!CONTENT_HINT_PATTERN.test(match[2])) {
      continue;
    }
    const candidateText = stripHtml(match[3]);
    if (candidateText.length >= 80) {
      candidates.push(candidateText);
    }
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    candidates.push(stripHtml(bodyMatch[1]));
  }
  candidates.push(stripHtml(html));

  const ranked = unique(candidates)
    .map((text) => ({ text, score: scoreReadableText(text) }))
    .sort((left, right) => right.score - left.score);

  return cleanReadableText(ranked[0]?.text || "");
}

function extractDomainSpecificReadableText(html, sourceUrl) {
  const rule = DOMAIN_CONTENT_PATTERNS.find((entry) => entry.hostPattern.test(safeHostname(sourceUrl)));
  if (!rule) {
    return "";
  }

  for (const pattern of rule.patterns) {
    const match = pattern.exec(html);
    if (!match) {
      continue;
    }

    const tagName = match[1]?.toLowerCase();
    const innerHtml = extractBalancedElementInnerHtml(html, match.index, tagName);
    if (!innerHtml) {
      continue;
    }

    const transformedHtml = rule.transformHtml ? rule.transformHtml(innerHtml) : innerHtml;
    const cleanedHtml = applyCleanupPatterns(transformedHtml, rule.cleanupPatterns || []);
    const text = cleanReadableText(stripHtml(cleanedHtml));
    if (text) {
      return text;
    }
  }

  return "";
}

function extractBalancedElementInnerHtml(html, startIndex, tagName) {
  if (!tagName) {
    return "";
  }

  const openTagPattern = new RegExp(`<\\/?${escapeRegex(tagName)}\\b[^>]*>`, "gi");
  openTagPattern.lastIndex = startIndex;

  let depth = 0;
  let contentStart = -1;
  let match;
  while ((match = openTagPattern.exec(html)) !== null) {
    const tag = match[0];
    const isClosingTag = tag.startsWith("</");
    if (depth === 0 && !isClosingTag) {
      depth = 1;
      contentStart = match.index + tag.length;
      continue;
    }

    if (isClosingTag) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(contentStart, match.index);
      }
      continue;
    }

    if (!tag.endsWith("/>")) {
      depth += 1;
    }
  }

  return "";
}

function applyCleanupPatterns(html, patterns) {
  return patterns.reduce((output, pattern) => output.replace(pattern, " "), html);
}

function scoreReadableText(text) {
  let score = text.length;
  for (const marker of BOILERPLATE_MARKERS) {
    if (text.includes(marker)) {
      score -= 80;
    }
  }

  if (text.includes("正文")) {
    score += 40;
  }
  if (text.includes("作者") || text.includes("记者")) {
    score += 20;
  }
  return score;
}

function cleanReadableText(text) {
  let cleaned = text || "";
  for (const marker of BOILERPLATE_MARKERS) {
    cleaned = cleaned.replace(new RegExp(escapeRegex(marker), "g"), " ");
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMeta(html, attrName, attrValue) {
  const pattern = new RegExp(`<meta[^>]*${attrName}=["']${escapeRegex(attrValue)}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
  return html.match(pattern)?.[1] || null;
}

function extractFirstTag(html, tag) {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return stripHtml(html.match(pattern)?.[1] || "");
}

function computeConfidence(baseConfidence, parsed, remediation) {
  let confidence = baseConfidence;
  if (parsed.fullText && parsed.fullText.length > 180) {
    confidence += 0.15;
  }
  if (parsed.publishedAt) {
    confidence += 0.05;
  }
  if (parsed.interactionSignal > 0) {
    confidence += 0.05;
  }
  if (remediation.allowExcerptOnly && (!parsed.fullText || parsed.fullText.length < 120)) {
    confidence -= 0.1;
  }
  return Math.max(0.2, Math.min(0.98, confidence));
}

function extractIsoLikeDate(text) {
  const match = text.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?/);
  return match?.[0] || null;
}

function extractInteractionSignal(text) {
  const match = text.match(/(点赞|在看|阅读|转发)[^\d]{0,5}(\d{2,8})/);
  return match ? Number(match[2]) : 0;
}
