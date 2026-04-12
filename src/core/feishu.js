import path from "node:path";
import { writeJson, writeText } from "../utils/fs.js";
import { createTimeoutSignal } from "../utils/http.js";

export async function deliverDigestToFeishu({ digest, reportUrl, envConfig, runContext, logger }) {
  const payload = buildFeishuPayload(digest, reportUrl);

  if (!envConfig.feishuWebhookUrl) {
    const previewPath = path.join(runContext.privateDataDir, "runs", `${runContext.runId}-feishu-preview.json`);
    await writeJson(previewPath, payload);
    logger.warn("feishu webhook missing, wrote preview instead", { previewPath });
    return { delivered: false, previewPath, payload };
  }

  const response = await fetch(envConfig.feishuWebhookUrl, {
    method: "POST",
    signal: createTimeoutSignal(15000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`feishu webhook failed with status ${response.status}: ${body}`);
  }

  logger.info("feishu message delivered");
  return { delivered: true, payload };
}

export function buildFeishuPayload(digest, reportUrl) {
  const bodyLines = [];
  bodyLines.push(digest.topline_summary);
  bodyLines.push("");

  for (const section of digest.theme_sections) {
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

  if (digest.connections.length) {
    bodyLines.push("关联关系");
    for (const item of digest.connections) {
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

  bodyLines.push(`完整日报：${reportUrl}`);

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
                text: bodyLines.join("\n")
              }
            ]
          ]
        }
      }
    }
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

  if (!envConfig.feishuWebhookUrl) {
    const previewPath = path.join(runContext.privateDataDir, "runs", `${runContext.runId}-incident-preview.md`);
    await writeText(previewPath, text);
    logger.warn("feishu incident preview written", { previewPath });
    return { delivered: false, previewPath };
  }

  const response = await fetch(envConfig.feishuWebhookUrl, {
    method: "POST",
    signal: createTimeoutSignal(15000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msg_type: "text",
      content: {
        text
      }
    })
  });

  if (!response.ok) {
    throw new Error(`feishu incident delivery failed with status ${response.status}`);
  }

  return { delivered: true };
}
