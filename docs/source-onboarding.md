# Source Onboarding

## Add whitelist sources

Edit `config/whitelist_sources.yaml` and append a new source:

```json
{
  "name": "你的来源名",
  "source_type": "公众号",
  "priority_weight": 1.8,
  "seed_urls": ["https://example.com/listing-page"],
  "notes": "为什么需要重点跟踪"
}
```

## Add discovery providers

Set `DISCOVERY_PROVIDER_SEARCH_TEMPLATES` to a JSON array of search pages:

```json
[
  "https://example-search.com/search?q={query}"
]
```

The system will:

1. Expand queries from `config/discovery_keywords.yaml`
2. Fetch search pages
3. Extract candidate links
4. Scrape article pages
5. Fall back to excerpt-only mode when needed

## Tuning

- If too noisy: tighten keywords or raise `minimum_story_score`
- If too sparse: add whitelist sources and more discovery templates
- If some domains are consistently broken: add dedicated parsers in `src/providers/`
