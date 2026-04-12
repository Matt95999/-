import path from "node:path";
import { resolveRootDir } from "../core/pipeline.js";
import { listJsonFiles, readJson } from "../utils/fs.js";

const rootDir = resolveRootDir(import.meta.url);
const incidentDir = path.join(rootDir, "private-data", "incidents");
const latest = await listJsonFiles(incidentDir);

if (!latest.length) {
  console.log(JSON.stringify({ ok: true, incidents: [] }, null, 2));
  process.exit(0);
}

const incidents = [];
for (const file of latest.slice(0, 10)) {
  incidents.push(await readJson(file.fullPath));
}

console.log(JSON.stringify({ ok: true, incidents }, null, 2));
