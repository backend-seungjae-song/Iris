// 대화 화면 링크 끝에 붙은 한글 조사·어미와 문장 부호를 링크 밖 글자로
// - Paseo 링크 인식(BARE_URL)은 공백·따옴표·괄호까지를 주소로 봄 → `https://example.com에` 전체가 링크
// - 끝 규칙은 터미널 링크와 같은 함수(web/js/panel/url-token.js, 빌드에 iris-url-token.js 로 복사)
// - Paseo 가 그린 <a> 의 글자만 줄이고 뺀 글자는 바로 뒤 span 으로. 다시 그리면 다음 프레임에 다시 맞춤

const TAIL = "iris-link-tail";

// 링크 글자가 주소 그대로일 때만 { url, tail }. 마크다운으로 쓴 [글](주소) 링크는 건드리지 않음
export function splitUrlTail(text, urlToken) {
  const s = String(text || "");
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  const url = urlToken(s);
  if (!url || url === s || !s.startsWith(url) || !/^https?:\/\/./i.test(url)) return null;
  return { url, tail: s.slice(url.length) };
}

// 열 주소. Paseo 가 window.open 으로 넘기는 주소는 다듬기 전 글이고 퍼센트 인코딩일 수 있음
// - URL 표준 형태로 맞춤. 한 번 누름이 <a> 클릭(a.href)과 window.open 둘로 와서 같은 주소인지 글자로 비교함
export function openableUrl(href, urlToken) {
  let s = String(href || "");
  try { s = decodeURI(s); } catch {}
  const url = splitUrlTail(s, urlToken)?.url ?? s;
  try { return new URL(url).href; } catch { return String(href || ""); }
}

function fix(a, urlToken) {
  const node = a.firstChild;
  if (!node || node !== a.lastChild || node.nodeType !== Node.TEXT_NODE) return;
  const split = splitUrlTail(node.nodeValue, urlToken);
  if (!split) return;
  node.nodeValue = split.url;
  a.setAttribute("href", split.url);
  a.dataset.irisTail = split.tail;
  const next = a.nextSibling;
  if (next instanceof HTMLElement && next.classList.contains(TAIL)) next.remove();
  const span = document.createElement("span");
  span.className = TAIL;
  span.textContent = split.tail;
  a.after(span);
}

function scan(urlToken) {
  for (const a of document.querySelectorAll('a[href^="http"]')) fix(a, urlToken);
  // 링크가 사라졌거나 다시 그려져 짝이 없는 뒤 글자
  for (const span of document.querySelectorAll(`span.${TAIL}`)) {
    const a = span.previousSibling;
    if (!(a instanceof HTMLAnchorElement) || a.dataset.irisTail !== span.textContent || a.textContent.endsWith(span.textContent)) span.remove();
  }
}

export function installLinkTail(urlToken) {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(urlToken); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
}
