const ABSOLUTE_PATH = /(^|[\s('"`=:\[])\/(?!\/)[^\s'"`<>\])},;]+/gm;
const WINDOWS_QUOTED_PATH = /(['"`])((?:[A-Za-z]:[\\/]|\\\\|\/\/)[^\r\n]*?)\1/g;
// 공백 포함 경로의 끝 구분 불가. 다음 구분자·HTTP 주소까지 가림.
const WINDOWS_PATH = /(^|[\s('"`=:\[])(?:[A-Za-z]:[\\/]|\\\\|(?<!:)\/\/)(?:(?![ \t]+https?:\/\/)[^\r\n'"`<>\])},;])+/gm;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_HEX = /\b[0-9a-f]{32,64}\b/gi;

export function redactMacPaths(value, format = (label) => label, platform = process.platform) {
  let text = String(value ?? "");
  if (platform === "win32") {
    text = text.replace(WINDOWS_QUOTED_PATH, (_match, quote, pathname) => `${quote}${format("[Windows 경로]", pathname)}${quote}`)
      .replace(WINDOWS_PATH, (match, prefix) => `${prefix}${format("[Windows 경로]", match.slice(prefix.length))}`);
  }
  return text.replace(ABSOLUTE_PATH, (match, prefix) => `${prefix}${format("[Mac 경로]", match.slice(prefix.length))}`)
    .replace(UUID, (match) => format("[내부 식별자]", match)).replace(LONG_HEX, (match) => format("[내부 식별자]", match));
}

export function redactPrivateText(value, identifiers = [], format = (label) => label) {
  let text = redactMacPaths(value, format);
  for (const identifier of identifiers) {
    if (typeof identifier !== "string" || identifier.length < 2) continue;
    text = text.split(identifier).join(format("[내부 식별자]", identifier));
  }
  return text;
}

export function truncateUtf8(value, maximumBytes) {
  const source = String(value ?? "");
  if (Buffer.byteLength(source, "utf8") <= maximumBytes) return { text: source, truncated: false };
  let low = 0, high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(source.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(source[low - 1])) low--;
  return { text: source.slice(0, low), truncated: true };
}

// 폰 계약의 주소 한도(2048자). 넘는 주소 하나가 탭 목록 응답 전체를 막지 않게 빈 값
const PUBLIC_URL_MAX = 2048;

export function publicHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.href.length > PUBLIC_URL_MAX) return "";
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}
