export function renderDigestMarkdown(digest) {
  const lines = [
    `# ${digest.daily_brief_title}`,
    "",
    `> ${digest.topline_summary}`,
    "",
    "## 头部产品覆盖面板",
    ""
  ];

  for (const item of digest.coverage_board || []) {
    lines.push(`- ${item.display_name}：${item.status_label}（上次更新：${item.last_known_update_label}）`);
  }

  lines.push("", "## 按产品线出块");

  for (const section of digest.product_sections || []) {
    lines.push("", `### ${section.title}`, "", section.summary);
    for (const storyId of section.story_ids) {
      const story = digest.story_items.find((item) => item.story_id === storyId);
      if (!story) {
        continue;
      }
      lines.push("", `#### ${story.headline}`, "");
      for (const sentence of story.narrative) {
        lines.push(`- ${sentence}`);
      }
      lines.push(`- ${story.conclusion}`);
      lines.push(`- ${story.impact}`);
      lines.push(`- 原文：${story.source_links.join(" | ")}`);
    }
  }

  if ((digest.cross_product_connections || []).length) {
    lines.push("", "## 跨产品线关联分析", "");
    for (const connection of digest.cross_product_connections) {
      lines.push(`- ${connection}`);
    }
  }

  lines.push("", "## 继续观察", "");
  for (const item of digest.watchlist) {
    lines.push(`- ${item}`);
  }

  lines.push("", "## 今日缺口", "");
  for (const item of digest.missing_products || []) {
    lines.push(`- ${item.product_id}：${item.reason}`);
  }

  return `${lines.join("\n")}\n`;
}
