import path from "node:path";
import { loadResourceText } from "./resource-loader.js";
import { sha256 } from "../utils/hash.js";
import { stripHtml, truncate, unique } from "../utils/text.js";
import { nowIso } from "../utils/time.js";

const ARTICLE_LINK_PATTERN = /https?:\/\/[^\s"'<>]+|file:\/\/[^\s"'<>]+/g;

export async function discoverCandidates({ rootDir, config, envConfig, logger }) {
  const discovered = [];

  const whitelistCandidates = await discoverFromWhitelist({
    config,
    envConfig,
    logger
  });
  discovered.push(...whitelistCandidates);

  const searchCandidates = await discoverFromProviders({
    rootDir,
    config,
    envConfig,
    logger
  });
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
        const links = extractLinks(seedUrl, text);
        if (!links.length) {
          results.push(baseCandidateFromSource(source, seedUrl, null));
          continue;
        }
        for (const link of links) {
          results.push(baseCandidateFromSource(source, link, text));
        }
      } catch (error) {
        logger.warn("whitelist discovery failed", { source: source.name, seedUrl, error: error.message });
      }
    }
  }

  return results;
}

async function discoverFromProviders({ rootDir, config, envConfig, logger }) {
  const results = [];
  const queries = buildQueries(config.keywords);

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
        const html = await loadResourceText(url, envConfig.discoveryProviderRequestHeaders);
        const links = extractLinks(url, html);
        for (const link of links.slice(0, 5)) {
          results.push({
            source_name: inferSourceName(link),
            source_type: "公众号",
            url: link,
            title: query,
            discovered_at: nowIso(),
            published_at: null,
            excerpt: truncate(stripHtml(html), 160),
            full_text: null,
            signals: {
              query,
              discovery_source: "search-template",
              search_url: url,
              source_priority: 0.6
            },
            confidence: 0.45,
            content_hash: sha256(`${query}|${link}`)
          });
        }
      } catch (error) {
        logger.warn("search provider failed", { template, query, error: error.message });
      }
    }
  }

  return results;
}

function buildQueries(keywordConfig) {
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
  return unique(queries);
}

function extractLinks(baseUrl, text) {
  const urls = text.match(ARTICLE_LINK_PATTERN) || [];
  return unique(
    urls
      .filter((url) => url !== baseUrl)
      .filter((url) => !url.endsWith(".jpg") && !url.endsWith(".png") && !url.endsWith(".css"))
  );
}

function baseCandidateFromSource(source, url, seedText) {
  return {
    source_name: source.name,
    source_type: source.source_type || "公众号",
    url,
    title: source.name,
    discovered_at: nowIso(),
    published_at: null,
    excerpt: seedText ? truncate(stripHtml(seedText), 140) : null,
    full_text: null,
    signals: {
      discovery_source: "whitelist",
      source_priority: source.priority_weight || 1
    },
    confidence: 0.6,
    content_hash: sha256(`${source.name}|${url}`)
  };
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
