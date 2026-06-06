# 飞书投递迁移方案：AnyCross / Webhook 触发器

## 结论

当前日报系统已从单一 `FEISHU_WEBHOOK_URL` 自定义机器人投递，升级为多通道 Feishu delivery adapter。

推荐生产配置：

- `FEISHU_DELIVERY_PROVIDER=anycross`
- `FEISHU_ANYCROSS_WEBHOOK_URL=<AnyCross Webhook 触发器地址>`

迁移期保留旧机器人：

- `FEISHU_DELIVERY_PROVIDER=auto`
- 同时保留 `FEISHU_WEBHOOK_URL`

`auto` 的优先级固定为：

1. `FEISHU_ANYCROSS_WEBHOOK_URL`
2. `FEISHU_WEBHOOK_TRIGGER_URL`
3. `FEISHU_WEBHOOK_URL`

## 为什么选 AnyCross

日报系统的需求是“外部定时任务把结构化内容送进飞书”。这类需求与 AnyCross 的 Webhook 触发器最匹配：

- GitHub Actions / 本地任务只负责生成结构化 JSON。
- AnyCross 负责后续飞书消息发送、字段映射、异常通知和低代码调整。
- 后续如果飞书机器人助手或旧自定义机器人能力变化，只需要调整 AnyCross 流程，不需要改日报核心代码。

## AnyCross 触发器收到的 payload

日报成功投递：

```json
{
  "event_type": "ai_digest_daily",
  "source": "ai-wechat-digest",
  "version": "2026-06-06",
  "title": "头部大模型情报日报 2026-06-06",
  "text": "完整中文日报正文",
  "report_url": "https://matt95999.github.io/-/daily/2026-06-06/",
  "digest_payload": {
    "headline": "头部大模型情报日报 2026-06-06",
    "topline": "今日主线...",
    "coverage_board": [],
    "sections": [],
    "connections": [],
    "watchlist": [],
    "missing_products": [],
    "report_url": "https://matt95999.github.io/-/daily/2026-06-06/"
  }
}
```

失败审查通知：

```json
{
  "event_type": "ai_digest_incident",
  "source": "ai-wechat-digest",
  "title": "任务失败通知：summarize",
  "text": "失败阶段、原因、已补救动作和推荐后续"
}
```

信源审计摘要：

```json
{
  "event_type": "ai_digest_source_audit",
  "source": "ai-wechat-digest",
  "title": "AI 日报信源审计摘要",
  "text": "本次 source_audit 摘要"
}
```

## GitHub 配置

Repository variables:

- `FEISHU_DELIVERY_PROVIDER=anycross`

Repository secrets:

- `FEISHU_ANYCROSS_WEBHOOK_URL`

可选：

- `FEISHU_WEBHOOK_TRIGGER_URL`
- `FEISHU_WEBHOOK_TRIGGER_TOKEN`
- `FEISHU_WEBHOOK_URL`

## 验证

本地预检：

```bash
npm run preflight_check -- --mode daily_run
```

只重发飞书：

```bash
npm run feishu_only
```

GitHub Actions：

- 触发 `Daily Digest`
- 检查 `Run preflight checks` 中 `feishu_delivery_channel` 为 `pass`
- 检查飞书收到日报

## 回滚

如果 AnyCross 暂不可用：

1. 将 `FEISHU_DELIVERY_PROVIDER` 改为 `auto` 或 `custom_bot`
2. 保留旧 `FEISHU_WEBHOOK_URL`
3. 触发 `feishu_only`

核心日报、发布页和私有运行数据不受影响。
