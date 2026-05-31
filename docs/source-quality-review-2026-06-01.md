# 数据源质量审查与修复记录 2026-06-01

## 审查结论

本次引入独立质量审查视角后，确认当前系统的主要风险不是“数据源数量不足”，而是部分候选在证据强度不足时仍可能进入高置信日报。

重点风险包括：

- 官方页面抓取失败后，仅凭 RSS 摘要进入高置信排序。
- 无 `published_at` 的 changelog 条目使用扫描时间参与时效评分。
- 10 天以上甚至更旧的官方更新虽然是真实内容，但不应被写成“今天的重点新闻”。
- 同一 changelog 页面多个锚点被当成多源重复，抬高 `cross_source_repetition`。
- 中文日期与特殊 changelog 页面结构解析不足。
- Codex、Claude Code 需要更稳定、更结构化的官方源。

## 已完成修复

### 1. 证据等级进入评分

抓取阶段新增 `signals.evidence_level`：

- `full_text`
- `excerpt_only`
- `excerpt_only_failed`

评分阶段新增 `evidence_quality`，抓取失败的官方新闻摘要不再能作为高置信证据直接进入头部日报。

### 2. 高置信更新必须有可靠日期

评分不再用 `discovered_at` 冒充发布时间。缺少 `published_at` 的候选会被限制最高分，避免旧页面或导航内容在扫描当天变成“最新更新”。

日报入选窗口收紧为最近 7 天。超过窗口的官方更新仍会保留在排序审计中，但最高分被压到高置信阈值以下，只用于来源健康和新鲜度判断，不进入正文重点摘要。

### 3. 重复提及改为按唯一来源计算

`cross_source_repetition` 现在按唯一 `source_id` 或 host 计算，不再因为同一个官方 changelog 页面下多个 hash 锚点而虚增重复确认。

### 4. 日期解析增强

新增支持：

- `YYYY年M月D日`
- changelog URL hash 中的 `MM-DD-YY`
- dated-card 页面结构中的 `<time>YYYY-MM-DD</time>`
- Mintlify 更新页中的版本号 + 日期块

### 5. 数据源刷新

替换和调整：

- Codex 主源改为 `https://developers.openai.com/codex/changelog/`
- Claude Code 主源改为 `https://code.claude.com/docs/en/changelog`
- OpenAI Newsroom 的 ChatGPT/Codex 权重降到 `0.72`，只作为官方新闻补充源
- `deepseek-home` 因长期 `success_empty` 被运行态停用
- Qwen Code 增加教程/用例类内容过滤
- 日报措辞从“今天出现”改为“本期入选”，避免把数日前但仍在 7 天窗口内的官方更新误写成当天发布。
- DeepSeek 返回的 `generated_at` 不再被信任，统一改用本地运行时间，避免 UTC 日期偏移污染发布页。

保留：

- DeepSeek API Updates
- Gemini API Changelog
- Qwen 官方博客
- Kimi 开放平台博客与 changelog
- GLM 新品发布

## 当前行为边界

- 如果某产品线本期没有可靠日期、可靠官方 changelog 或正文证据，系统会倾向输出“未发现高置信官方更新”，而不是用弱证据补位。
- OpenAI News RSS 仍可用于发现 ChatGPT/Codex 信号，但正文抓取失败时只作为低证据候选，不再自然进入高置信。
- Kimi、DeepSeek、GLM 这类单页 changelog 源会保留，但同源多个锚点不会再被当作多源重复。

## 后续建议

1. 继续观察 7 天 `top_ranked_candidates.json`，确认新证据门槛和 7 天入选窗口不会漏掉重要产品更新。
2. 为 ChatGPT release notes 寻找更适合当前 fetch 管线的官方替代入口；Help Center 仍可能返回 403。
3. 若 Kimi 或 GLM 长期无新日期条目，不要降低门槛补内容，应接受“今日无高置信更新”。
4. 后续如引入媒体交叉验证，应作为“验证层”，不要替代官方主源。
