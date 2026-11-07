// 같은 내용이면 DOM 을 바꾸지 않는 innerHTML 대입
// - 상태 방송마다 목록을 새로 만들면 마우스를 올린 줄의 강조가 꺼졌다 다시 켜지며 깜빡임(2026-11-07 사용자 보고)
// - 그 사이 다른 코드가 DOM 을 직접 바꿨으면(이름 고치기 입력칸 등) 같은 내용이라도 다시 그림
const drawn = new WeakMap();

// keep: 다시 만들어지는 안쪽 스크롤 칸의 선택자. 같은 순서의 새 칸에 이전 스크롤 위치를 되돌림
// - 내용이 바뀌어 다시 그릴 때마다 맨 위로 튀던 화면용
// 반환: 실제로 다시 그렸으면 true
export function setHtml(el, html, { keep = "" } = {}) {
  const last = drawn.get(el);
  if (last && last.html === html && el.innerHTML === last.dom) return false;
  const at = keep && el.querySelectorAll ? [...el.querySelectorAll(keep)].map((n) => [n.scrollTop, n.scrollLeft]) : [];
  el.innerHTML = html;
  if (at.length) [...el.querySelectorAll(keep)].forEach((n, i) => { if (at[i]) [n.scrollTop, n.scrollLeft] = at[i]; });
  drawn.set(el, { html, dom: el.innerHTML });
  return true;
}
