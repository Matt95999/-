import { loadResourceText } from "./resource-loader.js";
import { StageError } from "../core/errors.js";
import { sha256 } from "../utils/hash.js";
import { extractSentences, stripHtml, truncate } from "../utils/text.js";
import { nowIso } from "../utils/time.js";

export async function scrapeCandidates(candidates, { envConfig, logger, remediation }) {
  const results = [];
  const failures = [];

  for (const candidate of candidates) {
    try {
      const html = await loadResourceText(candidate.url, envConfig.discoveryProviderRequestHeaders);
      const parsed = parseArticlePage(html);
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

export function parseArticlePage(html) {
  const fullText = stripHtml(html);
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

function extractMeta(html, attrName, attrValue) {
  const pattern = new RegExp(`<meta[^>]*${attrName}=["']${escapeRegex(attrValue)}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
  return html.match(pattern)?.[1] || null;
}

function extractFirstTag(html, tag) {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return stripHtml(html.match(pattern)?.[1] || "");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
