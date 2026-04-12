import path from "node:path";
import { readText } from "../utils/fs.js";

export async function loadResourceText(resource, headers = {}) {
  if (!resource) {
    throw new Error("empty resource");
  }

  if (resource.startsWith("file://")) {
    return readText(fileUrlToPath(resource));
  }

  if (resource.startsWith("/") || resource.startsWith("./") || resource.startsWith("../")) {
    return readText(path.resolve(resource));
  }

  const response = await fetch(resource, {
    headers: {
      "user-agent": "ai-wechat-digest/0.1 (+https://github.com/)",
      ...headers
    }
  });

  if (!response.ok) {
    throw new Error(`failed to fetch ${resource}: ${response.status}`);
  }

  return response.text();
}

function fileUrlToPath(fileUrl) {
  return decodeURIComponent(fileUrl.replace("file://", ""));
}
