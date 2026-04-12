export function createLogger(runId) {
  return {
    info(message, extra) {
      log("INFO", runId, message, extra);
    },
    warn(message, extra) {
      log("WARN", runId, message, extra);
    },
    error(message, extra) {
      log("ERROR", runId, message, extra);
    }
  };
}

function log(level, runId, message, extra) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[${level}] [${runId}] ${message}${suffix}`);
}
