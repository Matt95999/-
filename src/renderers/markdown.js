export function renderDigestMarkdown(digest) {
  const lines = [
    `# ${digest.daily_brief_title}`,
    "",
    `> ${digest.topline_summary}`,
    "",
    "## 今日主线"
  ];

  for (const section of digest.theme_sections) {
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

  lines.push("", "## 关联判断", "");
  for (const connection of digest.connections) {
    lines.push(`- ${connection}`);
  }

  lines.push("", "## 继续观察", "");
  for (const item of digest.watchlist) {
    lines.push(`- ${item}`);
  }

  return `${lines.join("\n")}\n`;
}
