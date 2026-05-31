import { nowIso } from "../utils/time.js";

const GENERATED_OVERRIDE_FIELDS = new Set([
  "enabled",
  "priority_weight",
  "cooldown_until",
  "degrade_reason",
  "last_auto_action",
  "last_auto_action_at",
  "quarantined",
  "avg_update_interval_days"
]);

export function mergeSourceRegistry({ registry = {}, generatedSources = {}, now = new Date() }) {
  const productMap = new Map((registry.products || []).map((product) => [product.product_id, normalizeProduct(product)]));
  const sourceOverrides = new Map(
    (generatedSources.sources || [])
      .filter((entry) => entry?.source_id)
      .map((entry) => [entry.source_id, normalizeGeneratedOverride(entry)])
  );

  const sources = (registry.sources || []).map((source) =>
    resolveSource({
      source,
      override: sourceOverrides.get(source.source_id),
      productMap,
      now
    })
  );

  const sourceMap = new Map(sources.map((source) => [source.source_id, source]));
  const activeProducts = [...productMap.values()].filter((product) => product.status === "active");
  const candidateProducts = [...productMap.values()].filter((product) => product.status === "candidate");

  return {
    products: [...productMap.values()],
    productMap,
    sources,
    sourceMap,
    activeProducts,
    candidateProducts,
    generatedSources: normalizeGeneratedSources(generatedSources),
    registryLoadedAt: nowIso()
  };
}

export function summarizeSourceMix(registryState) {
  const summary = [];
  for (const product of registryState.activeProducts || []) {
    const sources = (registryState.sources || []).filter(
      (source) => source.enabled && Array.isArray(source.product_ids) && source.product_ids.includes(product.product_id)
    );
    summary.push({
      product_id: product.product_id,
      display_name: product.display_name,
      enabled_source_count: sources.length,
      source_roles: [...new Set(sources.map((source) => source.source_role))].sort()
    });
  }
  return summary;
}

function normalizeProduct(product) {
  return {
    vendor_id: product.vendor_id,
    product_id: product.product_id,
    display_name: product.display_name,
    region: product.region || "global",
    priority_tier: product.priority_tier || "supplement",
    status: product.status || "candidate",
    detection_terms: normalizeStringArray(product.detection_terms),
    sub_products: (product.sub_products || []).map((subProduct) => ({
      sub_product_id: subProduct.sub_product_id,
      display_name: subProduct.display_name,
      detection_terms: normalizeStringArray(subProduct.detection_terms)
    }))
  };
}

function resolveSource({ source, override, productMap, now }) {
  const base = {
    source_id: source.source_id,
    display_name: source.display_name || source.name || source.source_id,
    name: source.display_name || source.name || source.source_id,
    source_type: source.source_type || "官方来源",
    source_role: source.source_role || "official_news",
    vendor_id: source.vendor_id || inferVendorFromProducts(source.product_ids, productMap),
    product_ids: normalizeStringArray(source.product_ids),
    status: source.status || "candidate",
    priority_weight: safeNumber(source.priority_weight, 0.8),
    expected_update_cadence: source.expected_update_cadence || "medium",
    evaluation_enabled: Boolean(source.evaluation_enabled),
    allowed_hosts: normalizeStringArray(source.allowed_hosts),
    seed_urls: normalizeStringArray(source.seed_urls),
    include_url_patterns: normalizeStringArray(source.include_url_patterns),
    exclude_url_patterns: normalizeStringArray(source.exclude_url_patterns),
    include_entry_text_patterns: normalizeStringArray(source.include_entry_text_patterns),
    exclude_entry_text_patterns: normalizeStringArray(source.exclude_entry_text_patterns),
    entry_strategy: source.entry_strategy || "listing",
    require_published_at: Boolean(source.require_published_at),
    maximum_entry_age_days: safeInteger(source.maximum_entry_age_days, 0),
    max_entries: safeInteger(source.max_entries, 8),
    notes: source.notes || "",
    enabled: source.status === "active",
    cooldown_until: null,
    degrade_reason: "",
    last_auto_action: "",
    last_auto_action_at: "",
    quarantined: false,
    avg_update_interval_days: null
  };

  if (override) {
    for (const [key, value] of Object.entries(override)) {
      if (GENERATED_OVERRIDE_FIELDS.has(key)) {
        base[key] = value;
      }
    }
  }

  if (base.cooldown_until && new Date(base.cooldown_until).getTime() > now.getTime()) {
    base.enabled = false;
  }

  if (base.quarantined) {
    base.enabled = false;
  }

  base.products = base.product_ids
    .map((productId) => productMap.get(productId))
    .filter(Boolean)
    .map((product) => ({
      product_id: product.product_id,
      display_name: product.display_name,
      vendor_id: product.vendor_id,
      priority_tier: product.priority_tier,
      status: product.status,
      region: product.region,
      sub_products: product.sub_products
    }));

  return base;
}

function normalizeGeneratedSources(generatedSources) {
  return {
    sources: (generatedSources.sources || []).map(normalizeGeneratedOverride)
  };
}

function normalizeGeneratedOverride(entry) {
  const output = { source_id: entry.source_id };
  for (const field of GENERATED_OVERRIDE_FIELDS) {
    if (field in entry) {
      output[field] = entry[field];
    }
  }
  return output;
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}

function inferVendorFromProducts(productIds, productMap) {
  for (const productId of productIds || []) {
    const product = productMap.get(productId);
    if (product?.vendor_id) {
      return product.vendor_id;
    }
  }
  return "";
}

function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
