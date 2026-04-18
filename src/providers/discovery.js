import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadResourceText } from "./resource-loader.js";
import { sha256 } from "../utils/hash.js";
import { decodeHtmlEntities, stripHtml, truncate, unique } from "../utils/text.js";
import { nowIso } from "../utils/time.js";

const ARTICLE_LINK_PATTERN = /https?:\/\/[^\s"'<>]+|file:\/\/[^\s"'<>]+/g;
const HTML_ANCHOR_PATTERN = /<a\b([^>]*)href=["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
const HTML_ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)=["']([^"']*)["']/g;
const XML_ITEM_PATTERN = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
const REDIRECT_PARAM_NAMES = ["url", "target", "targetUrl", "dest", "destination", "u", "to", "redirect"];
const BLOCKED_URL_PROTOCOLS = ["javascript:", "mailto:", "tel:", "data:"];
const BLOCKED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".css", ".js", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".zip"];
const LISTING_SEGMENTS = new Set(["blog", "news", "archive", "archives", "about", "category", "categories", "tag", "tags", "topics", "topic", "page"]);

export async function discoverCandidates({ rootDir, config, envConfig, logger, mode = "daily_run" }) {
  const discovered = [];

  const whitelistCandidates = await discoverFromWhitelist({
    config,
    envConfig,
    logger
  });
  discovered.push(...whitelistCandidates);

  const searchCandidates = shouldUseProviderSources({ mode, whitelistConfig: config.whitelist, whitelistCandidates })
    ? await discoverFromProviders({
        rootDir,
        config,
        envConfig,
        logger
      })
    : [];
  discovered.push(...searchCandidates);

  const deduped = dedupeCandidates(discovered);
  logger.info("discovery completed", {
    discovered: deduped.length,
    whitelist: whitelistCandidates.length,
    provider: searchCandidates.length
  });
  return deduped;
}

async function discoverFromWhitelist({ config, envConfig, logger }) {
  const results = [];

  for (const source of config.whitelist.sources || []) {
    for (const seedUrl of source.seed_urls || []) {
      try {
        const text = await loadResourceText(seedUrl, envConfig.discoveryProviderRequestHeaders);
        const entries = extractDiscoveryEntries({
          resourceUrl: seedUrl,
          text,
          sourceName: source.name,
          sourceType: source.source_type || "公众号",
          discoverySource: "whitelist",
          sourcePriority: source.priority_weight || 1,
          allowedHosts: source.allowed_hosts || [],
          includeUrlPatterns: source.include_url_patterns || [],
          excludeUrlPatterns: source.exclude_url_patterns || []
        }).slice(0, source.max_entries || 12);
        if (!entries.length) {
          logger.warn("whitelist source yielded no article entries", { source: source.name, seedUrl });
          continue;
        }
        for (const entry of entries) {
          results.push(entry);
        }
      } catch (error) {
        logger.warn("whitelist discovery failed", { source: source.name, seedUrl, error: error.message });
      }
    }
  }

  return results;
}

function shouldUseProviderSources({ mode, whitelistConfig, whitelistCandidates }) {
  if (mode === "manual_review") {
    return true;
  }

  const hasConfiguredWhitelist = (whitelistConfig?.sources || []).some((source) => Array.isArray(source.seed_urls) && source.seed_urls.length);
  if (hasConfiguredWhitelist) {
    return false;
  }

  return whitelistCandidates.length === 0;
}

async function discoverFromProviders({ rootDir, config, envConfig, logger }) {
  const results = [];
  const queries = buildQueries(config.keywords, envConfig.discoveryProviderMaxQueries);

  if (envConfig.discoveryProviderSampleFile) {
    const sampleText = await loadResourceText(envConfig.discoveryProviderSampleFile, envConfig.discoveryProviderRequestHeaders);
    const sampleItems = JSON.parse(sampleText);
    for (const item of sampleItems) {
      results.push({
        source_name: item.source_name || "sample-provider",
        source_type: item.source_type || "公众号",
        url: item.url,
        title: item.title || item.query,
        discovered_at: nowIso(),
        published_at: item.published_at || null,
        excerpt: item.excerpt || null,
        full_text: null,
        signals: {
          query: item.query || "",
          discovery_source: "sample-file",
          source_priority: 0.8
        },
        confidence: 0.7,
        content_hash: sha256(`${item.url}|${item.title || item.query}`)
      });
    }
  }

  for (const template of envConfig.discoveryProviderSearchTemplates || []) {
    for (const query of queries) {
      try {
        const url = template.replaceAll("{query}", encodeURIComponent(query));
        const text = await loadResourceText(url, envConfig.discoveryProviderRequestHeaders);
        const entries = extractDiscoveryEntries({
          resourceUrl: url,
          text,
          sourceType: "公众号",
          discoverySource: "search-template",
          sourcePriority: 0.6,
          query,
          fallbackTitle: query
        });
        for (const entry of entries.slice(0, 5)) {
          results.push(entry);
        }
      } catch (error) {
        logger.warn("search provider failed", { template, query, error: error.message });
      }
    }
  }

  return results;
}

export function buildQueries(keywordConfig, maxQueries = 0) {
  const expansions = keywordConfig.query_expansions || [];
  const queries = [];
  for (const theme of keywordConfig.themes || []) {
    for (const term of theme.terms || []) {
      if (!expansions.length) {
        queries.push(term);
      }
      for (const expansion of expansions) {
        queries.push(`${term} ${expansion}`);
      }
    }
  }
  const deduped = unique(queries);
  return maxQueries > 0 ? deduped.slice(0, maxQueries) : deduped;
}

function extractLinks(baseUrl, text) {
  const normalizedBaseUrl = normalizeUrl(baseUrl, baseUrl) || baseUrl;
  const urls = text.match(ARTICLE_LINK_PATTERN) || [];
  return unique(
    urls
      .map((url) => normalizeUrl(url, baseUrl))
      .filter(Boolean)
      .filter((url) => url !== normalizedBaseUrl)
      .filter((url) => isLikelyArticleUrl(url, baseUrl))
      .filter((url) => !isBlockedResourceUrl(url))
  );
}

export function extractDiscoveryEntries({
  resourceUrl,
  text,
  sourceName = "",
  sourceType = "公众号",
  discoverySource = "search-template",
  sourcePriority = 0.6,
  allowedHosts = [],
  includeUrlPatterns = [],
  excludeUrlPatterns = [],
  query = "",
  fallbackTitle = ""
}) {
  const baseUrl = makeBaseUrl(resourceUrl);
  const rawEntries = uniqueEntriesByUrl([
    ...extractJsonEntries(text, baseUrl),
    ...extractXmlEntries(text, baseUrl),
    ...extractHtmlAnchorEntries(text, baseUrl),
    ...extractFallbackUrlEntries(text, baseUrl)
  ]);

  return rawEntries
    .filter((entry) => matchesAllowedHosts(entry.url, allowedHosts))
    .filter((entry) => matchesUrlPatterns(entry.url, includeUrlPatterns, excludeUrlPatterns))
    .map((entry) =>
      toCandidate(entry, {
        resourceUrl,
        sourceName,
        sourceType,
        discoverySource,
        sourcePriority,
        query,
        fallbackTitle
      })
    );
}

function toCandidate(entry, options) {
  const url = entry.url;
  const title = cleanText(entry.title) || options.fallbackTitle || inferTitleFromUrl(url);
  const excerpt = cleanExcerpt(entry.excerpt, title);

  return {
    source_name: options.sourceName || entry.sourceName || inferSourceName(url),
    source_type: options.sourceType || "公众号",
    url,
    title,
    discovered_at: nowIso(),
    published_at: normalizePublishedAt(entry.publishedAt),
    excerpt,
    full_text: null,
    signals: {
      query: options.query || "",
      discovery_source: options.discoverySource,
      search_url: options.discoverySource === "search-template" ? options.resourceUrl : undefined,
      source_priority: options.sourcePriority,
      discovery_format: entry.format
    },
    confidence: confidenceByFormat(entry.format),
    content_hash: sha256(`${url}|${title}`)
  };
}

function extractJsonEntries(text, baseUrl) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  return collectJsonEntries(data, baseUrl, 0);
}

function collectJsonEntries(node, baseUrl, depth) {
  if (depth > 4 || !node) {
    return [];
  }

  if (Array.isArray(node)) {
    const directEntries = node.map((value) => normalizeJsonEntry(value, baseUrl)).filter(Boolean);
    if (directEntries.length) {
      return directEntries;
    }
    for (const value of node.slice(0, 20)) {
      const nestedEntries = collectJsonEntries(value, baseUrl, depth + 1);
      if (nestedEntries.length) {
        return nestedEntries;
      }
    }
    return [];
  }

  if (typeof node !== "object") {
    return [];
  }

  const directEntry = normalizeJsonEntry(node, baseUrl);
  if (directEntry) {
    return [directEntry];
  }

  for (const key of ["items", "entries", "articles", "results", "data", "list", "records"]) {
    if (node[key] !== undefined) {
      const nestedEntries = collectJsonEntries(node[key], baseUrl, depth + 1);
      if (nestedEntries.length) {
        return nestedEntries;
      }
    }
  }

  for (const value of Object.values(node).slice(0, 20)) {
    const nestedEntries = collectJsonEntries(value, baseUrl, depth + 1);
    if (nestedEntries.length) {
      return nestedEntries;
    }
  }

  return [];
}

function normalizeJsonEntry(item, baseUrl) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const url = normalizeUrl(
    pickString(item, ["url", "link", "share_url", "shareUrl", "article_url", "articleUrl", "permalink"]),
    baseUrl
  );
  if (!url || isBlockedResourceUrl(url)) {
    return null;
  }

  return {
    url,
    title: pickString(item, ["title", "name", "headline"]),
    excerpt: pickString(item, ["summary", "excerpt", "description", "content_text", "contentSnippet"]),
    publishedAt: pickString(item, ["published_at", "publishedAt", "pubDate", "date", "updated_at", "updatedAt"]),
    sourceName: pickString(item, ["source_name", "sourceName", "author", "account_name"]),
    format: "json"
  };
}

function extractXmlEntries(text, baseUrl) {
  if (!text.includes("<rss") && !text.includes("<feed") && !text.includes("<entry") && !text.includes("<item")) {
    return [];
  }

  const entries = [];
  XML_ITEM_PATTERN.lastIndex = 0;
  let match;
  while ((match = XML_ITEM_PATTERN.exec(text)) !== null) {
    const block = match[0];
    const url = normalizeUrl(
      extractXmlTag(block, "link") || extractXmlAttribute(block, "link", "href") || extractXmlTag(block, "guid") || extractXmlTag(block, "id"),
      baseUrl
    );
    if (!url || isBlockedResourceUrl(url)) {
      continue;
    }

    entries.push({
      url,
      title: cleanText(extractXmlTag(block, "title")),
      excerpt: cleanText(
        extractXmlTag(block, "description") ||
          extractXmlTag(block, "summary") ||
          extractXmlTag(block, "content:encoded") ||
          extractXmlTag(block, "content")
      ),
      publishedAt:
        extractXmlTag(block, "pubDate") ||
        extractXmlTag(block, "published") ||
        extractXmlTag(block, "updated") ||
        extractXmlTag(block, "dc:date"),
      format: "xml"
    });
  }

  return entries;
}

function extractHtmlAnchorEntries(text, baseUrl) {
  if (!text.includes("<a")) {
    return [];
  }

  const entries = [];
  HTML_ANCHOR_PATTERN.lastIndex = 0;
  let match;
  while ((match = HTML_ANCHOR_PATTERN.exec(text)) !== null) {
    const href = match[2];
    const url = normalizeUrl(href, baseUrl);
    if (!url || isBlockedResourceUrl(url) || !isLikelyArticleUrl(url, baseUrl)) {
      continue;
    }

    const attrs = parseHtmlAttributes(`${match[1]} ${match[3]}`);
    const title = cleanText(stripHtml(match[4])) || cleanText(attrs.title) || cleanText(attrs["aria-label"]);
    if (!title || title.length < 4) {
      continue;
    }

    entries.push({
      url,
      title,
      excerpt: cleanText(attrs.title && attrs.title !== title ? attrs.title : ""),
      format: "html"
    });
  }

  return entries;
}

function extractFallbackUrlEntries(text, baseUrl) {
  return extractLinks(baseUrl, text).map((url) => ({
    url,
    title: "",
    excerpt: "",
    format: "url"
  }));
}

function parseHtmlAttributes(input) {
  const attrs = {};
  HTML_ATTRIBUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = HTML_ATTRIBUTE_PATTERN.exec(input)) !== null) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2]);
  }
  return attrs;
}

function extractXmlTag(xml, tag) {
  const pattern = new RegExp(`<${escapeRegex(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, "i");
  return cleanText(stripCdata(xml.match(pattern)?.[1] || ""));
}

function extractXmlAttribute(xml, tag, attr) {
  const pattern = new RegExp(`<${escapeRegex(tag)}\\b[^>]*${escapeRegex(attr)}=["']([^"']+)["'][^>]*\\/?>`, "i");
  return cleanText(xml.match(pattern)?.[1] || "");
}

function pickString(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function stripCdata(text) {
  return text.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1");
}

function cleanText(text) {
  return decodeHtmlEntities((text || "").replace(/\s+/g, " ").trim());
}

function cleanExcerpt(excerpt, title) {
  const normalized = cleanText(excerpt);
  if (!normalized || normalized === title) {
    return null;
  }
  return truncate(normalized, 180);
}

function normalizePublishedAt(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return text;
  }
  return parsed.toISOString();
}

function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) {
    return null;
  }

  const trimmed = decodeHtmlEntities(rawUrl).trim();
  if (!trimmed || BLOCKED_URL_PROTOCOLS.some((protocol) => trimmed.startsWith(protocol))) {
    return null;
  }

  try {
    const url =
      trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("file://")
        ? trimmed
        : new URL(trimmed, baseUrl).toString();
    return unwrapRedirectUrl(url);
  } catch {
    return null;
  }
}

function unwrapRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    for (const paramName of REDIRECT_PARAM_NAMES) {
      const target = parsed.searchParams.get(paramName);
      if (target && /^https?:\/\//.test(target)) {
        return target;
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function makeBaseUrl(resourceUrl) {
  if (!resourceUrl) {
    return "file:///";
  }

  if (resourceUrl.startsWith("http://") || resourceUrl.startsWith("https://") || resourceUrl.startsWith("file://")) {
    return resourceUrl;
  }

  return pathToFileURL(path.resolve(resourceUrl)).toString();
}

function isBlockedResourceUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return BLOCKED_EXTENSIONS.some((extension) => pathname.endsWith(extension));
  } catch {
    return BLOCKED_EXTENSIONS.some((extension) => url.toLowerCase().endsWith(extension));
  }
}

function uniqueEntriesByUrl(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry?.url) {
      continue;
    }
    const existing = map.get(entry.url);
    if (!existing || confidenceByFormat(entry.format) > confidenceByFormat(existing.format)) {
      map.set(entry.url, entry);
    }
  }
  return [...map.values()];
}

function confidenceByFormat(format) {
  switch (format) {
    case "json":
      return 0.78;
    case "xml":
      return 0.72;
    case "html":
      return 0.56;
    default:
      return 0.45;
  }
}

function isLikelyArticleUrl(url, baseUrl) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("mid") || parsed.searchParams.has("idx")) {
      return true;
    }

    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    if (!pathSegments.length || isLikelyListingPath(pathSegments, parsed)) {
      return false;
    }

    const lastSegment = pathSegments.at(-1)?.toLowerCase() || "";
    const articleLikeSegments = new Set(["article", "articles", "post", "posts", "news", "story", "entry", "blog", "archive", "archives"]);
    if (pathSegments.some((segment) => articleLikeSegments.has(segment.toLowerCase())) && lastSegment.length >= 4) {
      return true;
    }
    if (pathSegments.some((segment) => /^\d{4}([_-]?\d{2}){0,2}$/.test(segment))) {
      return true;
    }
    if (pathSegments.length >= 2 && lastSegment.length >= 8) {
      return true;
    }

    const baseHost = safeHostname(baseUrl);
    return parsed.hostname !== baseHost && pathSegments.length >= 1 && lastSegment.length >= 8;
  } catch {
    return false;
  }
}

function isLikelyListingPath(pathSegments, parsedUrl) {
  const lowerSegments = pathSegments.map((segment) => segment.toLowerCase());
  const lastSegment = lowerSegments.at(-1) || "";

  if (LISTING_SEGMENTS.has(lastSegment) && lowerSegments.length <= 2) {
    return true;
  }

  if (lowerSegments.includes("page")) {
    const pageIndex = lowerSegments.indexOf("page");
    if (/^\d+$/.test(lowerSegments[pageIndex + 1] || "")) {
      return true;
    }
  }

  if (["archive", "archives", "about"].includes(lastSegment)) {
    return true;
  }

  if (parsedUrl.searchParams.has("page") || parsedUrl.searchParams.has("category") || parsedUrl.searchParams.has("tag")) {
    return true;
  }

  return false;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function matchesAllowedHosts(url, allowedHosts) {
  if (!Array.isArray(allowedHosts) || !allowedHosts.length) {
    return true;
  }

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return allowedHosts.some((allowedHost) => {
      const normalized = String(allowedHost || "").trim().toLowerCase();
      return normalized && (hostname === normalized || hostname.endsWith(`.${normalized}`));
    });
  } catch {
    return false;
  }
}

function matchesUrlPatterns(url, includePatterns, excludePatterns) {
  if (Array.isArray(excludePatterns) && excludePatterns.some((pattern) => testPattern(url, pattern))) {
    return false;
  }

  if (!Array.isArray(includePatterns) || !includePatterns.length) {
    return true;
  }

  return includePatterns.some((pattern) => testPattern(url, pattern));
}

function testPattern(value, pattern) {
  if (!pattern) {
    return false;
  }

  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return String(value).includes(String(pattern));
  }
}

function dedupeCandidates(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    const existing = map.get(candidate.url);
    if (!existing || existing.confidence < candidate.confidence) {
      map.set(candidate.url, candidate);
    }
  }
  return [...map.values()];
}

function inferSourceName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return path.basename(url);
  }
}

function inferTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
    return decodeHtmlEntities(lastSegment || parsed.hostname);
  } catch {
    return path.basename(url);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
