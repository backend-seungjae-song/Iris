// 링크별 계정 규칙: 주소 규칙 해석과 링크에 맞는 규칙 고르기(값만 받고 값만 돌려줌)
//
// 제공 API
//   parseLinkPattern(input) → { ok: true, pattern, host, path } | { ok: false, error }
//   describeLinkPattern(pattern) → 사람이 읽는 범위 설명
//   matchLinkRule(url, rules) → 맞는 규칙 하나 또는 null. rules: [{ pattern, profile }]
//   linkRuleForPageTab(url, openerUrl, rules) → 페이지가 연 새 탭에 쓸 규칙 또는 null
//
// 유지 조건
//   규칙 모양: "github.com"(그 도메인과 하위 도메인) 또는 "github.com/acme"(그 경로와 그 아래)
//   붙여 넣은 전체 주소도 받음: 스킴·www.·포트·쿼리·해시·끝 슬래시 제거
//   여러 규칙이 맞으면 가장 구체적인 것(긴 도메인, 그다음 긴 경로)
//   server/browser-state.js 의 linkRules.set 검사와 같은 모양(LINK_PATTERN_RE)

export const LINK_PATTERN_RE = /^[a-z0-9.-]+(\/[^\s?#]*)?$/;
const MAX_PATTERN = 300;

function splitHostPath(text) {
  const slash = text.indexOf("/");
  return slash < 0 ? [text, ""] : [text.slice(0, slash), text.slice(slash)];
}

export function parseLinkPattern(input) {
  let text = String(input ?? "").trim();
  if (!text) return { ok: false, error: "주소나 도메인을 입력하세요." };
  if (/\s/.test(text)) return { ok: false, error: "공백 없이 입력하세요." };
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\*\./, "");
  text = text.replace(/[?#].*$/, "");
  let [host, path] = splitHostPath(text);
  host = host.replace(/^[^@]*@/, "").replace(/:\d*$/, "").replace(/\.$/, "").toLowerCase().replace(/^www\./, "");
  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return { ok: false, error: "도메인을 알아볼 수 없습니다. 예: github.com" };
  path = path.replace(/\/+$/, "");
  const pattern = host + path;
  if (pattern.length > MAX_PATTERN) return { ok: false, error: "주소가 너무 깁니다." };
  return { ok: true, pattern, host, path };
}

export function describeLinkPattern(pattern) {
  const [host, path] = splitHostPath(String(pattern || ""));
  return path ? `${host}${path} 아래 주소 전체` : `${host} 전체(하위 도메인 포함)`;
}

function urlParts(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { host: u.hostname.replace(/\.$/, "").toLowerCase().replace(/^www\./, ""), path: u.pathname || "/" };
  } catch { return null; }
}

function ruleMatches(parts, pattern) {
  const [host, path] = splitHostPath(pattern);
  if (parts.host !== host && !parts.host.endsWith("." + host)) return false;
  if (!path) return true;
  return parts.path === path || parts.path.startsWith(path + "/");
}

export function matchLinkRule(url, rules) {
  const parts = urlParts(url);
  if (!parts || !Array.isArray(rules)) return null;
  let best = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== "string" || !LINK_PATTERN_RE.test(rule.pattern)) continue;
    if (!ruleMatches(parts, rule.pattern)) continue;
    const [host, path] = splitHostPath(rule.pattern);
    const score = host.length * 10000 + path.length;
    if (score > bestScore) { best = rule; bestScore = score; }
  }
  return best;
}

// 페이지가 연 새 탭(target=_blank)의 규칙. 원래 탭 주소와 같은 규칙이면 null(원래 탭 계정 유지)
// 같은 사이트 안의 새 탭(AWS 콘솔의 서비스 탭 등)은 원래 탭 로그인을 이어 써야 함
export function linkRuleForPageTab(url, openerUrl, rules) {
  const rule = matchLinkRule(url, rules);
  if (!rule) return null;
  const openerRule = openerUrl ? matchLinkRule(openerUrl, rules) : null;
  return openerRule && openerRule.pattern === rule.pattern ? null : rule;
}
