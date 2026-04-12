function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderDigestHtml(digest) {
  const sectionHtml = digest.theme_sections
    .map((section) => {
      const stories = section.story_ids
        .map((storyId) => digest.story_items.find((item) => item.story_id === storyId))
        .filter(Boolean)
        .map((story) => {
          const narrative = story.narrative.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
          const links = story.source_links
            .map((link) => `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(link)}</a>`)
            .join("<br>");
          return `
            <article class="story">
              <h3>${escapeHtml(story.headline)}</h3>
              ${narrative}
              <p><strong>${escapeHtml(story.conclusion)}</strong></p>
              <p>${escapeHtml(story.impact)}</p>
              <p class="links">${links}</p>
            </article>
          `;
        })
        .join("");
      return `
        <section class="section">
          <h2>${escapeHtml(section.title)}</h2>
          <p class="summary">${escapeHtml(section.summary)}</p>
          ${stories}
        </section>
      `;
    })
    .join("");

  const connections = digest.connections.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const watchlist = digest.watchlist.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(digest.daily_brief_title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f6ef;
        --text: #111111;
        --muted: #4b4b4b;
        --accent: #0a7f52;
        --line: #d9ddcc;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.6;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 32px 20px 64px;
      }
      h1, h2, h3 { margin: 0 0 12px; }
      .topline {
        font-size: 1.05rem;
        padding: 16px 0 24px;
        border-bottom: 1px solid var(--line);
      }
      .section {
        padding: 28px 0;
        border-bottom: 1px solid var(--line);
      }
      .story {
        padding: 16px 0;
      }
      .summary, .links, .meta { color: var(--muted); }
      a { color: var(--accent); }
      ul {
        padding-left: 20px;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="meta">生成时间：${escapeHtml(digest.generated_at)}</p>
      <h1>${escapeHtml(digest.daily_brief_title)}</h1>
      <p class="topline">${escapeHtml(digest.topline_summary)}</p>
      ${sectionHtml}
      <section class="section">
        <h2>关联判断</h2>
        <ul>${connections}</ul>
      </section>
      <section class="section">
        <h2>继续观察</h2>
        <ul>${watchlist}</ul>
      </section>
    </main>
  </body>
</html>
`;
}
