// 대화 화면 경로 링크: 경로 없는 파일 이름은 일반 글자로, 링크 우클릭은 부모 창 메뉴의 경로 복사로
// - Paseo 는 알려진 확장자의 파일 이름 단독(report.md)도 파일 링크로 그림. 어느 폴더의 파일인지 글에 없어 누르면 엉뚱한 파일을 찾음
// - Paseo 가 그린 <a> 에 표시만 붙임. 다시 그리면 다음 프레임에 다시 붙임

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LINE_SUFFIX = /:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/;

// 폴더 구분자·홈·주소 형식이 없는 파일 이름(줄 번호 허용)
export function isBareFileName(href) {
  const s = String(href || "").trim();
  if (!s || SCHEME.test(s) || /^[a-z]:[\\/]/i.test(s)) return false;
  return !/[\\/~]/.test(s);
}

// 우클릭으로 복사할 값. 주소는 그대로, 경로는 작업 폴더 기준 전체 경로에서 줄 번호를 뺌
export function linkCopyTarget(href, cwd) {
  const s = String(href || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return { kind: "url", text: s };
  let p = s;
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch { return null; }
  }
  p = p.replace(LINE_SUFFIX, "");
  const root = String(cwd || "").replace(/\/+$/, "");
  if (root && !/^[/~]/.test(p) && !/^[a-z]:[\\/]/i.test(p)) p = `${root}/${p.replace(/^\.\//, "")}`;
  return { kind: "path", text: p };
}

const PLAIN = "data-iris-plain";
const PLAIN_CSS = `a[${PLAIN}] { pointer-events: none; cursor: text; text-decoration: none !important; }
a[${PLAIN}], a[${PLAIN}] * { color: inherit !important; }`;

function scan() {
  for (const a of document.querySelectorAll("a[href]")) {
    const plain = isBareFileName(a.getAttribute("href"));
    if (plain && !a.hasAttribute(PLAIN)) a.setAttribute(PLAIN, "");
    else if (!plain && a.hasAttribute(PLAIN)) a.removeAttribute(PLAIN);
  }
}

// getCwd: 지금 대화의 작업 폴더. onMenu({ x, y, kind, text }): 부모 창에 메뉴 요청
export function installPathLinks({ getCwd, onMenu }) {
  const style = document.createElement("style");
  style.id = "iris-path-links";
  style.textContent = PLAIN_CSS;
  document.head.appendChild(style);
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  schedule();
  document.addEventListener("contextmenu", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || a.hasAttribute(PLAIN)) return;
    const target = linkCopyTarget(a.getAttribute("href"), getCwd());
    if (!target) return;
    e.preventDefault();
    onMenu({ x: e.clientX, y: e.clientY, ...target });
  }, true);
}
