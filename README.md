# AI 公众号情报日报系统 v1

这是一个可公开放在 GitHub 上的日报项目骨架，用来做以下事情：

- 从全网发现 AI 相关公众号文章线索
- 抓取正文或退化为摘录模式
- 聚类、评分、提炼成一份整体化日报
- 发布到 GitHub Pages
- 将日报以整体结构推送到飞书
- 失败后自动审查、自动补救，最多重试 5 次
- 发现层支持 HTML 搜索页、RSS/Atom、JSON Feed 等真实输入格式

## 设计边界

- 公开仓库只保存摘要、链接、评分、日报页面。
- 原始全文、失败日志、补救记录默认保存在 `private-data/`，也可同步到私有仓库。
- “高赞”定义为综合分，不依赖单一点赞数。
- 第一版默认允许非官方搜索/聚合来源用于“发现”，并以审查机制兜底。

## 目录

- `config/`: 配置文件，采用 JSON 兼容的 YAML 书写方式
- `schemas/`: 核心数据结构 schema
- `src/`: 发现、抓取、评分、摘要、发布、飞书、补救逻辑
- `daily/`: 公开 Markdown 日报
- `site/`: GitHub Pages 静态页面
- `private-data/`: 私有数据、运行记录、失败审查、样例

## 快速开始

1. 填写环境变量：

```bash
cp .env.example .env
```

2. 可选：先用样例数据跑通整条链路：

```bash
export DISCOVERY_PROVIDER_SAMPLE_FILE="$(pwd)/private-data/samples/discovery-results.json"
npm run daily_run
```

3. 正式运行前建议设置：

- `DEEPSEEK_API_KEY`
- `FEISHU_WEBHOOK_URL`
- `PUBLIC_BASE_URL`
- `DISCOVERY_PROVIDER_SEARCH_TEMPLATES`
- `DISCOVERY_PROVIDER_MAX_QUERIES`
- `PRIVATE_DATA_REPO_PAT` 与 `PRIVATE_DATA_REPO`（需要同步私有运行产物时）

`DISCOVERY_PROVIDER_SEARCH_TEMPLATES` 是 JSON 数组，元素是带 `{query}` 占位符的搜索 URL 模板，例如：

```json
[
  "https://example-search.local/search?q={query}"
]
```

搜索模板既可以返回 HTML 结果页，也可以返回 RSS/Atom 或 JSON 结构化结果。系统会优先抽取标题、摘要、发布时间和真实文章链接，并尝试解开常见跳转参数。

`DISCOVERY_PROVIDER_MAX_QUERIES` 可用于真实联调时限制本轮展开的查询数量，例如先只跑前 `4` 个查询，避免首次接入时请求量过大。

如果不设置搜索模板，系统仍然会处理白名单来源与样例来源。

## 工作流入口

- `npm run daily_run`
- `npm run retry_failed_run`
- `npm run publish_only`
- `npm run feishu_only`
- `npm run manual_review`
- `npm run preflight_check -- --mode publish_only`

`feishu_only` 会复用最近一次成功生成的 digest 补发飞书，不会重新执行发现和抓取。

## 配置说明

### `config/discovery_keywords.yaml`

- 定义发现关键词和主题
- 支持 `query_expansions`

### `config/whitelist_sources.yaml`

- 定义后续补充的公众号白名单
- 白名单可配置更高的抓取优先级与评分权重

### `config/scoring_rules.yaml`

- 定义综合分权重、最小质量阈值、最大补救次数

## 输出物

公开输出：

- `daily/YYYY-MM-DD.md`
- `site/index.html`
- `site/latest.json`
- `site/daily/YYYY-MM-DD/index.html`

私有输出：

- `private-data/runs/*.json`
- `private-data/incidents/*.json`

## GitHub Actions

仓库内置工作流：

- 每天 08:30 Asia/Shanghai 触发主任务（UTC 00:30）
- 支持手动重跑失败任务
- 运行前先执行 `preflight_check`
- 可选将生成内容自动提交回仓库
- 自动部署 `site/` 到 GitHub Pages
- 始终上传 `private-data/runs` 与 `private-data/incidents` 作为运行留痕

默认跑在 `ubuntu-latest`；如需切到自托管 runner，可设置仓库变量 `ACTIONS_RUNNER=self-hosted`。

如需把当前 run 的私有产物同步到单独私有仓库，可额外设置：

- `PRIVATE_DATA_REPO_BRANCH`，默认 `main`
- `PRIVATE_DATA_REPO_BASE_PATH`，用于给私有仓库存档加前缀目录
