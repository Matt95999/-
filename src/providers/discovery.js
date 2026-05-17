import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadResourceText } from "./resource-loader.js";
import { sha256 } from "../utils/hash.js";
import { decodeHtmlEntities, jaccardSimilarity, stripHtml, toSlug, truncate, unique } from "../utils/text.js";
import { nowIso } from "../utils/time.js";

const ARTICLE_LINK_PATTERN = /https?:\/\/[^\s"'<>]+|file:\/\/[^\s"'<>]+/g;
const HTML_ANCHOR_PATTERN = /<a\b([^>]*)href=["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
const HTML_ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)=["']([^"']*)["']/g;
const HTML_HEADING_PATTERN = /<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const XML_ITEM_PATTERN = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
const REDIRECT_PARAM_NAMES = ["url", "target", "targetUrl", "dest", "destination", "u", "to", "redirect"];
const BLOCKED_URL_PROTOCOLS = ["javascript:", "mailto:", "tel:", "data:"];
const BLOCKED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".css", ".js", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".zip", ".xml", ".atom"];
const LISTING_SEGMENTS = new Set(["blog", "news", "archive", "archives", "about", "category", "categories", "tag", "tags", "topics", "topic", "page", "subscribe", "subscription"]);
const HUMAN_DATE_PATTERN = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}\b/i;
const PRODUCT_TOKEN_NORMALIZERS = [
  [/gpt-5\.2-codex/gi, "gpt-5.2-codex"],
  [/gpt-5-codex/gi, "gpt-5-codex"],
  [/claude code/gi, "claude code"],
  [/chatgpt/gi, "chatgpt"],
  [/deepseek/gi, "deepseek"],
  [/qwen/gi, "qwen"],
  [/kimi/gi, "kimi"],
  [/glm/gi, "glm"]
];

export async function discoverCandidates({ rootDir, config, envConfig, logger, mode = "daily_run" }) {
  const effectiveConfig = ensureRegistryState(config);
  const { candidates: sourceCandidates, sourceRuns } = await discoverFromRegistry({
    config: effectiveConfig,
    envConfig,
    logger,
    mode
  });

  const discovered = [...sourceCandidates];
  const searchCandidates = shouldUseProviderSources({
    mode,
    registryState: effectiveConfig.registryState,
    sourceCandidates
  })
    ? await discoverFromProviders({
        rootDir,
        config: effectiveConfig,
        envConfig,
        logger
      })
    : [];

  discovered.push(...searchCandidates);

  const deduped = dedupeCandidates(discovered);
  logger.info("discovery completed", {
    discovered: deduped.length,
    registry: sourceCandidates.length,
    provider: searchCandidates.length,
    sourceRuns: sourceRuns.length
  });
  return { candidates: deduped, sourceRuns };
}

function ensureRegistryState(config) {
  if (config?.registryState?.sources) {
    return config;
  }

  const sources = (config?.whitelist?.sources || []).map((source, index) => ({
    source_id: source.source_id || `legacy-source-${index + 1}`,
    display_name: source.name || `Legacy Source ${index + 1}`,
    source_type: source.source_type || "官方来源",
    source_role: source.source_role || "official_news",
    vendor_id: source.vendor_id || "",
    product_ids: source.product_ids || [],
    status: source.status || "active",
    priority_weight: source.priority_weight || 0.8,
    expected_update_cadence: source.expected_update_cadence || "medium",
    evaluation_enabled: Boolean(source.evaluation_enabled),
    allowed_hosts: source.allowed_hosts || [],
    seed_urls: source.seed_urls || [],
    include_url_patterns: source.include_url_patterns || [],
    exclude_url_patterns: source.exclude_url_patterns || [],
    include_entry_text_patterns: source.include_entry_text_patterns || [],
    exclude_entry_text_patterns: source.exclude_entry_text_patterns || [],
    entry_strategy: source.entry_strategy || "listing",
    max_entries: source.max_entries || 8,
    enabled: source.enabled !== false
  }));

  return {
    ...config,
    registryState: {
      sources,
      activeProducts: [],
      productMap: new Map(),
      sourceMap: new Map(sources.map((source) => [source.source_id, source]))
    }
  };
}

async function discoverFromRegistry({ config, envConfig, logger, mode }) {
  const results = [];
  const sourceRuns = [];
  const sources = selectSourcesForMode(config.registryState, mode);

  for (const source of sources) {
    const sourceRun = createSourceRun(source);
    sourceRuns.push(sourceRun);

    for (const seedUrl of source.seed_urls || []) {
      sourceRun.discovery.seed_attempt_count += 1;
      try {
        const text = await loadResourceText(seedUrl, envConfig.discoveryProviderRequestHeaders);
        sourceRun.discovery.seed_success_count += 1;
        sourceRun.discovery.last_scanned_at = nowIso();
        const entryLimit = mode === "source_audit" ? Math.min(2, source.max_entries || 12) : source.max_entries || 12;
        const entries = extractEntriesForSource({
          source,
          registryState: config.registryState,
          resourceUrl: seedUrl,
          text
        }).slice(0, entryLimit);

        sourceRun.discovery.discovered_count += entries.length;
        if (entries.length) {
          sourceRun.discovery.status = "success_with_candidates";
        } else if (sourceRun.discovery.status !== "success_with_candidates") {
          sourceRun.discovery.status = "success_empty";
        }
        for (const entry of entries) {
          results.push(entry);
        }
      } catch (error) {
        sourceRun.discovery.errors.push({ seed_url: seedUrl, error: error.message });
        logger.warn("registry discovery failed", { source: source.display_name, seedUrl, error: error.message });
      }
    }

    if (!sourceRun.discovery.seed_success_count) {
      sourceRun.discovery.status = "failed";
    }
  }

  return { candidates: results, sourceRuns };
}

function selectSourcesForMode(registryState, mode) {
  if (mode === "source_audit") {
    return (registryState.sources || []).filter((source) => source.enabled || source.evaluation_enabled);
  }

  return (registryState.sources || []).filter((source) => source.enabled);
}

function shouldUseProviderSources({ mode, registryState, sourceCandidates }) {
  if (mode === "manual_review") {
    return true;
  }

  if ((registryState.sources || []).some((source) => source.enabled && source.seed_urls.length)) {
    return false;
  }

  return sourceCandidates.length === 0;
}

async function discoverFromProviders({ rootDir, config, envConfig, logger }) {
  const results = [];
  const queries = buildQueries(config.keywords, envConfig.discoveryProviderMaxQueries);

  if (envConfig.discoveryProviderSampleFile) {
    const sampleText = await loadResourceText(envConfig.discoveryProviderSampleFile, envConfig.discoveryProviderRequestHeaders);
    const sampleItems = JSON.parse(sampleText);
    for (const item of sampleItems) {
      const inferred = classifyAgainstRegistry(`${item.title || ""} ${item.excerpt || ""}`, config.registryState);
      results.push({
        source_name: item.source_name || "sample-provider",
        source_type: item.source_type || "公众号",
        source_id: item.source_id || "sample-provider",
        source_role: item.source_role || "official_news",
        source_status: item.source_status || "sample",
        vendor_id: item.vendor_id || "",
        product_ids: Array.isArray(item.product_ids) && item.product_ids.length ? item.product_ids : inferred.productIds,
        sub_product_ids: Array.isArray(item.sub_product_ids) && item.sub_product_ids.length ? item.sub_product_ids : inferred.subProductIds,
        url: item.url,
        title: item.title || item.query,
        discovered_at: nowIso(),
        published_at: item.published_at || null,
        excerpt: item.excerpt || null,
        full_text: null,
        language: item.language || detectLanguage(`${item.title || ""} ${item.excerpt || ""}`),
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
          const inferred = classifyAgainstRegistry(`${entry.title || ""} ${entry.excerpt || ""}`, config.registryState);
          results.push({
            ...entry,
            source_id: "search-template",
            source_role: "third_party_search",
            source_status: "provider",
            vendor_id: "",
            product_ids: inferred.productIds,
            sub_product_ids: inferred.subProductIds,
            language: detectLanguage(`${entry.title} ${entry.excerpt || ""}`)
          });
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

function extractEntriesForSource({ source, registryState, resourceUrl, text }) {
  const entries =
    source.entry_strategy === "inline_changelog"
      ? extractInlineChangelogEntries({ resourceUrl, text, source })
      : source.entry_strategy === "page_as_article"
        ? extractPageAsArticleEntries({ resourceUrl, text, source })
        : extractDiscoveryEntries({
            resourceUrl,
            text,
            sourceName: source.display_name,
            sourceType: source.source_type || "官方来源",
            discoverySource: "registry",
            sourcePriority: source.priority_weight || 1,
            allowedHosts: source.allowed_hosts || [],
            includeUrlPatterns: source.include_url_patterns || [],
            excludeUrlPatterns: source.exclude_url_patterns || []
          });

  return entries
    .filter((entry) => matchesEntryTextPatterns(entry, source.include_entry_text_patterns, source.exclude_entry_text_patterns))
    .map((entry) => enrichCandidateWithRegistry(entry, source, registryState));
}

function enrichCandidateWithRegistry(candidate, source, registryState) {
  const text = [candidate.title, candidate.excerpt, candidate.full_text].filter(Boolean).join(" ");
  const detected = classifyCandidateProducts(text, source, registryState);
  return {
    ...candidate,
    source_name: source.display_name,
    source_type: source.source_type,
    source_id: source.source_id,
    source_role: source.source_role,
    source_status: source.status,
    vendor_id: source.vendor_id,
    product_ids: detected.productIds,
    sub_product_ids: detected.subProductIds,
    language: detectLanguage(text),
    signals: {
      ...candidate.signals,
      source_priority: source.priority_weight,
      source_role: source.source_role,
      expected_update_cadence: source.expected_update_cadence
    }
  };
}

function classifyCandidateProducts(text, source, registryState) {
  const normalized = normalizeMatchableText(text);
  const productIds = [];
  const subProductIds = [];

  for (const productId of source.product_ids || []) {
    const product = registryState.productMap.get(productId);
    if (!product) {
      continue;
    }
    const matchesProduct =
      !product.detection_terms.length || product.detection_terms.some((term) => normalized.includes(normalizeMatchableText(term)));
    if (matchesProduct || (source.product_ids || []).length === 1) {
      if (!productIds.includes(productId)) {
        productIds.push(productId);
      }
      for (const subProduct of product.sub_products || []) {
        if ((subProduct.detection_terms || []).some((term) => normalized.includes(normalizeMatchableText(term)))) {
          subProductIds.push(subProduct.sub_product_id);
        }
      }
    }
  }

  return {
    productIds: productIds.length ? productIds : [...(source.product_ids || [])],
    subProductIds: unique(subProductIds)
  };
}

function classifyAgainstRegistry(text, registryState) {
  const normalized = normalizeMatchableText(text);
  const productIds = [];
  const subProductIds = [];
  for (const product of registryState?.activeProducts || []) {
    if ((product.detection_terms || []).some((term) => normalized.includes(normalizeMatchableText(term)))) {
      productIds.push(product.product_id);
      for (const subProduct of product.sub_products || []) {
        if ((subProduct.detection_terms || []).some((term) => normalized.includes(normalizeMatchableText(term)))) {
          subProductIds.push(subProduct.sub_product_id);
        }
      }
    }
  }
  return { productIds: unique(productIds), subProductIds: unique(subProductIds) };
}

function createSourceRun(source) {
  return {
    source_id: source.source_id,
    display_name: source.display_name,
    source_role: source.source_role,
    source_type: source.source_type,
    vendor_id: source.vendor_id,
    product_ids: [...(source.product_ids || [])],
    source_status: source.status,
    enabled: Boolean(source.enabled),
    evaluation_enabled: Boolean(source.evaluation_enabled),
    priority_weight: source.priority_weight,
    avg_update_interval_days: source.avg_update_interval_days || null,
    discovery: {
      status: "pending",
      seed_attempt_count: 0,
      seed_success_count: 0,
      discovered_count: 0,
      last_scanned_at: null,
      errors: []
    }
  };
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
    published_at: normalizePublishedAt(entry.publishedAt, `${title} ${entry.excerpt || ""}`),
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

function extractInlineChangelogEntries({ resourceUrl, text, source }) {
  const baseUrl = makeBaseUrl(resourceUrl);
  const entries = [];
  const matches = [...text.matchAll(HTML_HEADING_PATTERN)];
  let currentExactDate = null;
  let currentMonthContext = null;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const level = Number.parseInt(match[1].slice(1), 10);
    const attrs = parseHtmlAttributes(match[2] || "");
    const title = cleanText(stripHtml(match[3] || ""));
    if (!title) {
      continue;
    }

    const exactDate = parseHeadingDate(title);
    if (exactDate) {
      currentExactDate = exactDate;
      currentMonthContext = exactDate.slice(0, 7);
      continue;
    }

    const monthContext = parseMonthContext(title);
    if (monthContext) {
      currentMonthContext = monthContext;
      continue;
    }

    if (isGenericChangelogHeading(title) || level <= 1) {
      continue;
    }

    const nextMatch = matches[index + 1];
    const bodyStart = match.index + match[0].length;
    const bodyEnd = nextMatch ? nextMatch.index : text.length;
    const snippet = cleanText(stripHtml(text.slice(bodyStart, bodyEnd)));
    const excerpt = cleanExcerpt(snippet, title) || truncate(snippet, 220) || null;
    const entryUrl = attrs.id ? `${resourceUrl}#${attrs.id}` : `${resourceUrl}#${toSlug(title)}`;

    entries.push({
      url: normalizeUrl(entryUrl, baseUrl),
      title,
      excerpt,
      publishedAt: inferInlinePublishedAt(title, currentExactDate, currentMonthContext),
      format: "inline"
    });
  }

  return uniqueEntriesByUrl(entries);
}

function extractPageAsArticleEntries({ resourceUrl, text, source }) {
  const title =
    extractMeta(text, "property", "og:title") ||
    extractMeta(text, "name", "twitter:title") ||
    extractMeta(text, "name", "title") ||
    extractFirstTag(text, "h1") ||
    extractFirstTag(text, "title") ||
    source.display_name;
  const excerpt =
    extractMeta(text, "name", "description") ||
    extractMeta(text, "property", "og:description") ||
    "";
  return [
    {
      url: resourceUrl,
      title: cleanText(title),
      excerpt: cleanText(excerpt),
      publishedAt: normalizePublishedAt(extractHumanDate(text), title),
      format: "page"
    }
  ];
}

function matchesEntryTextPatterns(entry, includePatterns, excludePatterns) {
  const haystack = `${entry.title || ""} ${entry.excerpt || ""}`.trim();
  if (!haystack) {
    return false;
  }

  if (Array.isArray(excludePatterns) && excludePatterns.some((pattern) => testPattern(haystack, pattern))) {
    return false;
  }
  if (!Array.isArray(includePatterns) || !includePatterns.length) {
    return true;
  }
  return includePatterns.some((pattern) => testPattern(haystack, pattern));
}

function normalizeMatchableText(text) {
  let normalized = String(text || "").toLowerCase();
  for (const [pattern, replacement] of PRODUCT_TOKEN_NORMALIZERS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}

function parseHeadingDate(text) {
  const cleaned = cleanText(text).replace(/^date:\s*/i, "");
  const full = parseMonthDayYear(cleaned) || parseIsoDate(cleaned);
  return full;
}

function parseMonthContext(text) {
  const match = cleanText(text).match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{4})$/i);
  if (!match) {
    return null;
  }
  const month = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    sept: "09",
    oct: "10",
    nov: "11",
    dec: "12"
  }[match[1].toLowerCase()];
  return month ? `${match[2]}-${month}` : null;
}

function inferInlinePublishedAt(title, currentExactDate, currentMonthContext) {
  const titleDate = parseHeadingDate(title);
  if (titleDate) {
    return titleDate;
  }

  const dayMatch = cleanText(title).match(/^(\d{1,2})\s*[-:：]?\s*/);
  if (dayMatch && currentMonthContext) {
    return `${currentMonthContext}-${dayMatch[1].padStart(2, "0")}T00:00:00.000Z`;
  }

  return currentExactDate || null;
}

function isGenericChangelogHeading(title) {
  const normalized = cleanText(title).toLowerCase();
  return [
    "release notes",
    "releases notes",
    "changelog",
    "change log",
    "what's new",
    "news",
    "documentation",
    "product updates",
    "updates"
  ].includes(normalized);
}

function detectLanguage(text) {
  const chineseChars = (String(text || "").match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = String(text || "").match(/[A-Za-z]{2,}/g) || [];
  if (chineseChars >= englishWords.length) {
    return "zh-CN";
  }
  return "en";
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

function normalizePublishedAt(value, fallbackText = "") {
  const text = cleanText(value) || extractHumanDate(fallbackText);
  if (!text) {
    return null;
  }

  const humanDate = parseHumanDateToIso(text);
  if (humanDate) {
    return humanDate;
  }

  const isoDate = parseIsoDate(text);
  if (isoDate) {
    return isoDate;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return text;
  }
  return parsed.toISOString();
}

function extractHumanDate(text) {
  const normalized = cleanText(text);
  return normalized.match(HUMAN_DATE_PATTERN)?.[0] || "";
}

function parseHumanDateToIso(text) {
  const match = cleanText(text).match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]* (\d{1,2}), (\d{4})$/i);
  if (!match) {
    return null;
  }

  const monthIndex = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    sept: 8,
    oct: 9,
    nov: 10,
    dec: 11
  }[match[1].toLowerCase()];

  if (monthIndex === undefined) {
    return null;
  }

  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  return new Date(Date.UTC(year, monthIndex, day)).toISOString();
}

function parseMonthDayYear(text) {
  const match = cleanText(text).match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]* (\d{1,2}), (\d{4})$/i);
  if (!match) {
    return null;
  }
  return parseHumanDateToIso(`${match[1]} ${match[2]}, ${match[3]}`);
}

function parseIsoDate(text) {
  const match = cleanText(text).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
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
    case "inline":
      return 0.8;
    case "page":
      return 0.7;
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
    const articleLikeSegments = new Set(["article", "articles", "post", "posts", "news", "story", "entry", "blog", "archive", "archives", "update", "updates", "release", "releases"]);
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
  const byUrl = new Map();
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url);
    if (!existing || compareCandidateQuality(candidate, existing) > 0) {
      byUrl.set(candidate.url, candidate);
    }
  }

  const deduped = [...byUrl.values()];
  const filtered = [];
  for (const candidate of deduped) {
    const duplicateIndex = filtered.findIndex((existing) => isCrossLanguageDuplicate(existing, candidate));
    if (duplicateIndex === -1) {
      filtered.push(candidate);
      continue;
    }
    if (compareCandidateQuality(candidate, filtered[duplicateIndex]) > 0) {
      filtered[duplicateIndex] = mergeDuplicateCandidates(filtered[duplicateIndex], candidate);
    } else {
      filtered[duplicateIndex] = mergeDuplicateCandidates(candidate, filtered[duplicateIndex]);
    }
  }
  return filtered;
}

function compareCandidateQuality(left, right) {
  const leftScore = (left.language === "zh-CN" ? 5 : 0) + (left.confidence || 0) + ((left.excerpt || "").length > 40 ? 0.2 : 0);
  const rightScore = (right.language === "zh-CN" ? 5 : 0) + (right.confidence || 0) + ((right.excerpt || "").length > 40 ? 0.2 : 0);
  return leftScore - rightScore;
}

function isCrossLanguageDuplicate(left, right) {
  const leftProducts = (left.product_ids || []).join("|");
  const rightProducts = (right.product_ids || []).join("|");
  if (!leftProducts || leftProducts !== rightProducts) {
    return false;
  }
  const titleSimilarity = jaccardSimilarity(left.title || "", right.title || "");
  if (titleSimilarity >= 0.72) {
    return true;
  }
  const titlePrefix = normalizeMatchableText(left.title || "").slice(0, 80);
  const rightPrefix = normalizeMatchableText(right.title || "").slice(0, 80);
  return Boolean(titlePrefix && titlePrefix === rightPrefix);
}

function mergeDuplicateCandidates(primary, secondary) {
  return {
    ...primary,
    product_ids: unique([...(primary.product_ids || []), ...(secondary.product_ids || [])]),
    sub_product_ids: unique([...(primary.sub_product_ids || []), ...(secondary.sub_product_ids || [])]),
    excerpt: primary.excerpt || secondary.excerpt,
    full_text: primary.full_text || secondary.full_text,
    published_at: primary.published_at || secondary.published_at,
    confidence: Math.max(primary.confidence || 0, secondary.confidence || 0),
    signals: {
      ...secondary.signals,
      ...primary.signals
    }
  };
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
