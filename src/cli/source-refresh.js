import { resolveRootDir } from "../core/pipeline.js";
import { loadConfig } from "../core/config.js";
import { runSourceRefresh } from "../core/source-audit.js";

const rootDir = resolveRootDir(import.meta.url);
const config = await loadConfig(rootDir);
const result = runSourceRefresh({ config });
console.log(JSON.stringify(result, null, 2));
