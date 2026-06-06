import path from "node:path";
import { getAttemptArtifactId } from "./context.js";
import { writeJson, writeText } from "../utils/fs.js";
import { createTimeoutSignal } from "../utils/http.js";

const FEISHU_CHANNELS = new Set(["anycross", "webhook_trigger", "custom_bot"]);

export async function deliverDigestToFeishu({ digest, reportUrl, envConfig, runContext, logger }) {
  const text = buildDigestText(digest, reportUrl);
  const channel = resolveFeishuChannel(envConfig);
  const payload =
    channel.type === "custom_bot"
      ? buildFeishuPayload(digest, reportUrl)
      : buildWebhookTriggerPayload({
          eventType: "ai_digest_daily",
          title: digest.daily_brief_title,
          text,
          reportUrl,
          digest
        });

  return deliverFeishuPayload({
    channel,
    payload,
    previewFileName: `${getAttemptArtifactId(runContext)}-feishu-preview.json`,
    previewPayload: payload,
    runContext,
    logger,
    successMessage: "feishu message delivered"
  });
}

export function buildFeishuPayload(digest, reportUrl) {
  return {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: digest.daily_brief_title,
          content: [
            [
              {
                tag: "text",
                text: buildDigestText(digest, reportUrl)
              }
            ]
          ]
        }
      }
    }
  };
}

export function buildWebhookTriggerPayload({ eventType, title, text, reportUrl = "", digest = null }) {
  return {
    event_type: eventType,
    source: "ai-wechat-digest",
    version: "2026-06-06",
    title,
    text,
    report_url: reportUrl,
    digest_payload: digest ? buildFeishuDigestPayload(digest, reportUrl) : null
  };
}

export function resolveFeishuChannel(envConfig = {}) {
  const configuredProvider = normalizeProvider(envConfig.feishuDeliveryProvider);
  const candidates = [];

  if (configuredProvider === "auto") {
    candidates.push(
      ["anycross", envConfig.feishuAnycrossWebhookUrl],
      ["webhook_trigger", envConfig.feishuWebhookTriggerUrl],
      ["custom_bot", envConfig.feishuWebhookUrl]
    );
  } else if (configuredProvider === "anycross") {
    candidates.push(["anycross", envConfig.feishuAnycrossWebhookUrl]);
  } else if (configuredProvider === "webhook_trigger") {
    candidates.push(["webhook_trigger", envConfig.feishuWebhookTriggerUrl]);
  } else {
    candidates.push(["custom_bot", envConfig.feishuWebhookUrl]);
  }

  for (const [type, url] of candidates) {
    if (url) {
      return {
        type,
        url,
        headers: buildTriggerHeaders(envConfig)
      };
    }
  }

  return { type: configuredProvider, url: "", headers: {} };
}

export function describeFeishuChannel(envConfig = {}) {
  const channel = resolveFeishuChannel(envConfig);
  if (!channel.url) {
    return {
      configured: false,
      channel: channel.type,
      detail:
        channel.type === "auto"
          ? "missing FEISHU_ANYCROSS_WEBHOOK_URL, FEISHU_WEBHOOK_TRIGGER_URL, and FEISHU_WEBHOOK_URL"
          : `missing ${expectedEnvForChannel(channel.type)}`
    };
  }

  return {
    configured: true,
    channel: channel.type,
    detail: `${channel.type} configured`
  };
}

export async function deliverFailureIncident({ incident, recommendation, envConfig, runContext, logger }) {
  const text = [
    `任务失败通知：${incident.stage}`,
    `错误类型：${incident.error_type}`,
    `失败原因判断：${incident.root_cause_guess}`,
    `已执行补救：${incident.actions_taken.join("、")}`,
    `推荐后续：${recommendation}`
  ].join("\n");
  const channel = resolveFeishuChannel(envConfig);
  const payload =
    channel.type === "custom_bot"
      ? {
          msg_type: "text",
          content: { text }
        }
      : buildWebhookTriggerPayload({
          eventType: "ai_digest_incident",
          title: `任务失败通知：${incident.stage}`,
          text
        });

  return deliverFeishuPayload({
    channel,
    payload,
    previewFileName: `${getAttemptArtifactId(runContext)}-incident-preview.json`,
    previewText: text,
    runContext,
    logger,
    successMessage: "feishu incident delivered",
    failureMessage: "feishu incident delivery failed, wrote preview instead",
    nonOkMessage: "feishu incident delivery returned non-ok, wrote preview instead"
  });
}

export async function deliverSourceAuditSummary({ summaryText, envConfig, runContext, logger }) {
  if (!summaryText) {
    return { delivered: false, skipped: true };
  }

  const channel = resolveFeishuChannel(envConfig);
  const payload =
    channel.type === "custom_bot"
      ? {
          msg_type: "text",
          content: { text: summaryText }
        }
      : buildWebhookTriggerPayload({
          eventType: "ai_digest_source_audit",
          title: "AI 日报信源审计摘要",
          text: summaryText
        });

  return deliverFeishuPayload({
    channel,
    payload,
    previewFileName: `${getAttemptArtifactId(runContext)}-source-audit-preview.json`,
    previewText: summaryText,
    runContext,
    logger,
    successMessage: "feishu source audit summary delivered"
  });
}

async function deliverFeishuPayload({
  channel,
  payload,
  previewFileName,
  previewPayload = null,
  previewText = "",
  runContext,
  logger,
  successMessage,
  failureMessage = "feishu delivery failed, wrote preview instead",
  nonOkMessage = "feishu delivery returned non-ok, wrote preview instead"
}) {
  if (!channel.url) {
    const previewPath = path.join(
      runContext.privateDataDir,
      "runs",
      previewText ? previewFileName.replace(/\.json$/, ".md") : previewFileName
    );
    if (previewText) {
      await writeText(previewPath, previewText);
    } else {
      await writeJson(previewPath, previewPayload || payload);
    }
    logger.warn("feishu delivery channel missing, wrote preview instead", {
      channel: channel.type,
      previewPath
    });
    return { delivered: false, previewPath, payload, channel: channel.type };
  }

  const response = await fetch(channel.url, {
    method: "POST",
    signal: createTimeoutSignal(15000),
    headers: {
      "content-type": "application/json",
      ...channel.headers
    },
    body: JSON.stringify(payload)
  }).catch(async (error) => {
    const previewPath = path.join(runContext.privateDataDir, "runs", previewFileName);
    await writeJson(previewPath, payload);
    logger.warn(failureMessage, {
      channel: channel.type,
      previewPath,
      error: error.message
    });
    return null;
  });

  if (response === null) {
    return { delivered: false, channel: channel.type };
  }

  if (!response.ok) {
    const body = await response.text();
    const previewPath = path.join(runContext.privateDataDir, "runs", previewFileName);
    await writeJson(previewPath, payload);
    logger.warn(nonOkMessage, {
      channel: channel.type,
      previewPath,
      status: response.status,
      body: body.slice(0, 500)
    });
    return { delivered: false, previewPath, channel: channel.type };
  }

  logger.info(successMessage, { channel: channel.type });
  return { delivered: true, payload, channel: channel.type };
}

function buildDigestText(digest, reportUrl) {
  const bodyLines = [];
  bodyLines.push(digest.topline_summary);
  bodyLines.push("");

  bodyLines.push("头部产品覆盖面板");
  for (const item of digest.coverage_board || []) {
    bodyLines.push(`• ${item.display_name}：${item.status_label}（上次更新：${item.last_known_update_label}）`);
  }
  bodyLines.push("");

  for (const section of digest.product_sections || []) {
    bodyLines.push(`${section.title}`);
    bodyLines.push(section.summary);
    for (const storyId of section.story_ids) {
      const story = digest.story_items.find((item) => item.story_id === storyId);
      if (!story) {
        continue;
      }
      bodyLines.push(`• ${story.headline}`);
      for (const sentence of story.narrative) {
        bodyLines.push(`  ${sentence}`);
      }
      bodyLines.push(`  ${story.conclusion}`);
      bodyLines.push(`  ${story.impact}`);
      bodyLines.push(`  原文：${story.source_links[0]}`);
    }
    bodyLines.push("");
  }

  if ((digest.cross_product_connections || []).length) {
    bodyLines.push("跨产品线关联分析");
    for (const item of digest.cross_product_connections) {
      bodyLines.push(`• ${item}`);
    }
    bodyLines.push("");
  }

  if (digest.watchlist.length) {
    bodyLines.push("继续观察");
    for (const item of digest.watchlist) {
      bodyLines.push(`• ${item}`);
    }
    bodyLines.push("");
  }

  if ((digest.missing_products || []).length) {
    bodyLines.push("今日缺口");
    for (const item of digest.missing_products) {
      bodyLines.push(`• ${item.product_id}：${item.reason}`);
    }
    bodyLines.push("");
  }

  bodyLines.push(`完整日报：${reportUrl}`);
  return bodyLines.join("\n");
}

function buildFeishuDigestPayload(digest, reportUrl) {
  return {
    headline: digest.daily_brief_title,
    topline: digest.topline_summary,
    coverage_board: digest.coverage_board || [],
    sections: (digest.product_sections || []).map((section) => ({
      title: section.title,
      summary: section.summary,
      stories: section.story_ids
        .map((storyId) => digest.story_items.find((item) => item.story_id === storyId))
        .filter(Boolean)
        .map((story) => ({
          headline: story.headline,
          narrative: story.narrative,
          conclusion: story.conclusion,
          impact: story.impact,
          source_links: story.source_links
        }))
    })),
    connections: digest.cross_product_connections || [],
    watchlist: digest.watchlist || [],
    missing_products: digest.missing_products || [],
    report_url: reportUrl
  };
}

function buildTriggerHeaders(envConfig) {
  const headers = {};
  if (envConfig.feishuWebhookTriggerToken) {
    headers["x-ai-digest-token"] = envConfig.feishuWebhookTriggerToken;
  }
  return headers;
}

function normalizeProvider(value) {
  const provider = String(value || "auto").trim().toLowerCase();
  return provider === "bot" || provider === "legacy" || provider === "custom_robot"
    ? "custom_bot"
    : FEISHU_CHANNELS.has(provider)
      ? provider
      : "auto";
}

function expectedEnvForChannel(channel) {
  if (channel === "anycross") {
    return "FEISHU_ANYCROSS_WEBHOOK_URL";
  }
  if (channel === "webhook_trigger") {
    return "FEISHU_WEBHOOK_TRIGGER_URL";
  }
  return "FEISHU_WEBHOOK_URL";
}
