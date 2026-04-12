import path from "node:path";
import { writeJson } from "../utils/fs.js";
import { nowIso } from "../utils/time.js";
import { StageError } from "./errors.js";

export async function executeWithRemediation({ runContext, scoringConfig, executor, logger, envConfig }) {
  let latestIncident = null;
  let lastError = null;

  for (let attemptNo = 1; attemptNo <= scoringConfig.maximum_attempts; attemptNo += 1) {
    const remediation = remediationPlanForAttempt(attemptNo);
    logger.info("starting attempt", { attemptNo, remediation });
    try {
      const result = await executor({ attemptNo, remediation });
      return { success: true, result, latestIncident };
    } catch (error) {
      lastError = error;
      const incident = createIncident(runContext, attemptNo, error, remediation);
      latestIncident = incident;
      await persistIncident(runContext, incident);
      logger.warn("attempt failed", { attemptNo, stage: incident.stage, errorType: incident.error_type });
    }
  }

  if (!(lastError instanceof StageError)) {
    throw lastError;
  }

  const recommendation = buildRecommendation(latestIncident);
  return {
    success: false,
    latestIncident,
    recommendation,
    error: lastError
  };
}

function remediationPlanForAttempt(attemptNo) {
  return {
    allowExcerptOnly: attemptNo >= 2,
    allowLocalSummaryFallback: attemptNo >= 2,
    forceLocalSummary: attemptNo >= 4,
    partialPublish: attemptNo >= 5,
    actionsTaken: remediationActions(attemptNo)
  };
}

function remediationActions(attemptNo) {
  switch (attemptNo) {
    case 1:
      return ["重试当前抓取器"];
    case 2:
      return ["重试当前抓取器", "降级为摘录模式"];
    case 3:
      return ["更换抓取策略或备用来源", "降级为摘录模式"];
    case 4:
      return ["缩短摘要上下文", "切换到本地摘要回退"];
    default:
      return ["拆分失败批次局部补跑", "允许部分发布", "保留人工审查入口"];
  }
}

function createIncident(runContext, attemptNo, error, remediation) {
  const stageError =
    error instanceof StageError
      ? error
      : new StageError("unknown", "unknown_failure", error.message || "unknown error");

  return {
    run_id: runContext.runId,
    stage: stageError.stage,
    error_type: stageError.errorType,
    root_cause_guess: stageError.message,
    attempt_no: attemptNo,
    actions_taken: remediation.actionsTaken,
    status: attemptNo >= 5 ? "manual_review_required" : "retrying",
    created_at: nowIso(),
    details: stageError.details || {}
  };
}

async function persistIncident(runContext, incident) {
  const filePath = path.join(
    runContext.privateDataDir,
    "incidents",
    `${runContext.runId}-attempt-${incident.attempt_no}.json`
  );
  await writeJson(filePath, incident);
}

export function buildRecommendation(incident) {
  switch (incident?.stage) {
    case "discover":
      return "优先检查搜索模板、白名单入口页和请求头，再决定是否新增稳定来源。";
    case "scrape":
      return "优先检查正文解析策略与备用抓取来源，必要时先接受摘录模式完成日报。";
    case "summarize":
      return "优先降低摘要批次规模或改用本地回退，再确认 DeepSeek API 状态。";
    case "publish":
      return "优先检查输出目录权限、Pages 基础路径和最新生成文件是否损坏。";
    case "feishu":
      return "优先检查飞书机器人 webhook、关键词限制和消息体大小。";
    default:
      return "优先检查最近一次 incident 详情，先修复最靠前的失败阶段。";
  }
}
