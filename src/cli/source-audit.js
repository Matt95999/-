import { resolveRootDir } from "../core/pipeline.js";
import { loadConfig, loadDotEnv, loadEnvConfig } from "../core/config.js";
import { runSourceAudit } from "../core/source-audit.js";

const rootDir = resolveRootDir(import.meta.url);
await loadDotEnv(rootDir);
const config = await loadConfig(rootDir);
const envConfig = loadEnvConfig();
const result = await runSourceAudit({ rootDir, config, envConfig });

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}
