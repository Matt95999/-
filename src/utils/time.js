export function nowIso() {
  return new Date().toISOString();
}

export function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(date)
    .replaceAll("-", "-");
}

export function hoursAgo(isoLike) {
  if (!isoLike) {
    return 72;
  }
  const timestamp = new Date(isoLike).getTime();
  if (Number.isNaN(timestamp)) {
    return 72;
  }
  return Math.max(0, (Date.now() - timestamp) / 3_600_000);
}

export function formatShanghaiDate(isoLike) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(isoLike));
}
