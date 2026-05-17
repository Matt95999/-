import path from "node:path";
import { listJsonFiles, readJson } from "../utils/fs.js";
import { formatShanghaiDate, nowIso } from "../utils/time.js";

export async function buildCoverageContext({ rootDir, scoredClusters, sourceRuns, registryState, minimumStoryScore }) {
  const activeProducts = registryState.activeProducts || [];
  const lastKnownUpdates = await loadLastKnownUpdates(rootDir);
  const coveredProducts = [];
  const missingProducts = [];
  const coverageBoard = [];

  for (const product of activeProducts) {
    const productClusters = scoredClusters.filter(
      (cluster) =>
        (cluster.product_ids || []).includes(product.product_id) && (cluster.score || 0) >= (minimumStoryScore || 0)
    );
    const relevantSources = sourceRuns.filter((sourceRun) => (sourceRun.product_ids || []).includes(product.product_id));
    const hasScannedSource = relevantSources.some((sourceRun) => sourceRun.discovery.status !== "failed");
    const hasEnabledSource = relevantSources.length > 0;
    const lastUpdate = findLastKnownUpdate(product.product_id, productClusters, lastKnownUpdates);

    let status = "scanned_not_found";
    let status_label = "已扫描，未发现高置信官方更新";

    if (productClusters.length) {
      status = "has_update";
      status_label = "有高置信更新";
      coveredProducts.push(product.product_id);
    } else if (!hasEnabledSource || !hasScannedSource) {
      status = "source_gap";
      status_label = "信源异常，需人工关注";
      missingProducts.push({ product_id: product.product_id, reason: "source_gap" });
    } else {
      missingProducts.push({ product_id: product.product_id, reason: "scanned_not_found" });
    }

    coverageBoard.push({
      product_id: product.product_id,
      display_name: product.display_name,
      status,
      status_label,
      last_known_update_at: lastUpdate?.published_at || null,
      last_known_update_label: lastUpdate ? formatLastKnownUpdateLabel(lastUpdate.published_at) : "暂无历史命中"
    });
  }

  return {
    coverage_board: coverageBoard,
    covered_products: coveredProducts,
    missing_products: missingProducts,
    built_at: nowIso()
  };
}

export function groupClustersByProduct(scoredClusters, registryState, minimumStoryScore = 0) {
  const sections = [];
  for (const product of registryState.activeProducts || []) {
    const stories = scoredClusters.filter(
      (cluster) =>
        (cluster.product_ids || []).includes(product.product_id) && (cluster.score || 0) >= minimumStoryScore
    );
    if (!stories.length) {
      continue;
    }
    const storyIds = stories.map((story) => story.story_id);
    const subProductGroups = groupSubProducts(stories);
    sections.push({
      product_id: product.product_id,
      title: product.display_name,
      summary: buildProductSectionSummary(product.display_name, stories),
      story_ids: storyIds,
      sub_sections: subProductGroups
    });
  }
  return sections;
}

export function buildCrossProductConnections(scoredClusters, registryState) {
  const clustersByProduct = new Map();
  for (const cluster of scoredClusters) {
    const productId = cluster.primary_product_id;
    if (!productId) {
      continue;
    }
    if (!clustersByProduct.has(productId)) {
      clustersByProduct.set(productId, []);
    }
    clustersByProduct.get(productId).push(cluster);
  }

  const products = [...clustersByProduct.keys()];
  if (products.length < 2) {
    return [];
  }

  const connections = [];
  for (let index = 0; index < products.length - 1; index += 1) {
    const currentProduct = registryState.productMap.get(products[index]);
    const nextProduct = registryState.productMap.get(products[index + 1]);
    const currentStory = clustersByProduct.get(products[index])?.[0];
    const nextStory = clustersByProduct.get(products[index + 1])?.[0];
    if (!currentProduct || !nextProduct || !currentStory || !nextStory) {
      continue;
    }
    connections.push(
      `${currentProduct.display_name} 的“${currentStory.headline}”与 ${nextProduct.display_name} 的“${nextStory.headline}”都在指向同一条竞争主线：模型能力与产品化节奏正在同步加速。`
    );
  }
  return connections.slice(0, 4);
}

function groupSubProducts(stories) {
  const groups = new Map();
  for (const story of stories) {
    const subProductId = story.primary_sub_product_id;
    if (!subProductId) {
      continue;
    }
    if (!groups.has(subProductId)) {
      groups.set(subProductId, []);
    }
    groups.get(subProductId).push(story.story_id);
  }

  return [...groups.entries()].map(([sub_product_id, story_ids]) => ({
    sub_product_id,
    story_ids
  }));
}

function buildProductSectionSummary(displayName, stories) {
  if (stories.length === 1) {
    return `今天 ${displayName} 只有 1 条高置信更新，重点在于 ${stories[0].headline}。`;
  }
  return `今天 ${displayName} 共出现 ${stories.length} 条高置信更新，主线集中在 ${stories
    .slice(0, 2)
    .map((story) => story.headline)
    .join("、")}。`;
}

async function loadLastKnownUpdates(rootDir) {
  const runDir = path.join(rootDir, "private-data", "runs");
  const files = await listJsonFiles(runDir);
  const updates = new Map();

  for (const file of files.slice(0, 30)) {
    try {
      const runArtifact = await readJson(file.fullPath);
      for (const cluster of runArtifact?.clusters || []) {
        for (const productId of cluster.product_ids || []) {
          if (!updates.has(productId)) {
            updates.set(productId, {
              published_at: cluster.articles?.[0]?.published_at || runArtifact?.run?.startedAt || null,
              headline: cluster.headline
            });
          }
        }
      }
    } catch {
      continue;
    }
  }

  return updates;
}

function findLastKnownUpdate(productId, currentClusters, historicalUpdates) {
  if (currentClusters.length) {
    const cluster = currentClusters[0];
    return {
      published_at: cluster.articles?.[0]?.published_at || null,
      headline: cluster.headline
    };
  }
  return historicalUpdates.get(productId) || null;
}

function formatLastKnownUpdateLabel(isoLike) {
  if (!isoLike) {
    return "暂无历史命中";
  }
  const published = new Date(isoLike);
  if (Number.isNaN(published.getTime())) {
    return "时间待确认";
  }

  const ageDays = Math.floor((Date.now() - published.getTime()) / 86_400_000);
  if (ageDays <= 0) {
    return "今天";
  }
  if (ageDays === 1) {
    return "昨天";
  }
  if (ageDays >= 30) {
    return "30+ 天前";
  }
  return `${ageDays} 天前`;
}
