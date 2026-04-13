export function stripHtml(html) {
  return decodeHtmlEntities(
    html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  );
}

export function decodeHtmlEntities(text) {
  if (!text) {
    return "";
  }

  const namedEntities = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    mdash: "-",
    ndash: "-",
    hellip: "...",
    middot: "·"
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith("#x")) {
      const value = Number.parseInt(normalized.slice(2), 16);
      return Number.isNaN(value) ? match : String.fromCodePoint(value);
    }
    if (normalized.startsWith("#")) {
      const value = Number.parseInt(normalized.slice(1), 10);
      return Number.isNaN(value) ? match : String.fromCodePoint(value);
    }
    return namedEntities[normalized] || match;
  });
}

export function tokenize(text) {
  const tokens = text.match(/[\p{Script=Han}]|[A-Za-z0-9][A-Za-z0-9.+-]*/gu) || [];
  return tokens.map((token) => token.toLowerCase());
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function jaccardSimilarity(leftText, rightText) {
  const left = new Set(tokenize(leftText));
  const right = new Set(tokenize(rightText));
  if (!left.size || !right.size) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

export function truncate(text, maxLength = 220) {
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

export function extractSentences(text, maxSentences = 3) {
  const parts = text
    .split(/(?<=[。！？.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.slice(0, maxSentences);
}

export function toSlug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function parseJsonFromModelText(text) {
  if (!text) {
    throw new Error("empty model response");
  }

  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const payload = fenced ? fenced[1] : text;
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("model response does not contain JSON object");
  }
  return JSON.parse(payload.slice(start, end + 1));
}
