import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readText(filePath) {
  return readFile(filePath, "utf8");
}

export async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, String(content ?? ""), "utf8");
}

export async function writeJson(filePath, value) {
  const serialized = JSON.stringify(value, null, 2);
  await writeText(filePath, `${serialized ?? "null"}\n`);
}

export async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await writeJson(tempPath, value);
  await rename(tempPath, filePath);
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

export async function listFiles(dirPath, matcher = () => true) {
  try {
    const entries = await readdir(dirPath);
    const files = await Promise.all(
      entries
        .filter((entry) => matcher(entry))
        .map(async (entry) => {
          const fullPath = path.join(dirPath, entry);
          const fileStat = await stat(fullPath);
          return { fullPath, name: entry, mtimeMs: fileStat.mtimeMs };
        })
    );
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

export async function removeFile(filePath) {
  await rm(filePath, { force: true });
}
