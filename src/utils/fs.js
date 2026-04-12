import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readText(filePath) {
  return readFile(filePath, "utf8");
}

export async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, content, "utf8");
}

export async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(filePath) {
  const text = await readText(filePath);
  return JSON.parse(text);
}

export async function listJsonFiles(dirPath) {
  try {
    const entries = await readdir(dirPath);
    const files = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const fullPath = path.join(dirPath, entry);
          const fileStat = await stat(fullPath);
          return { fullPath, mtimeMs: fileStat.mtimeMs };
        }),
    );
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}
