// worker 사본 · 원본 cdp-control.cjs DRAW_MARKS 와 같은 페이지 함수 문자열 (test/mcp-worker-page-route.mjs 가 대조)
// 원본은 ⑧에서 지움
// 페이지 위에 표시를 그린다. 찍은 뒤 전부 지우므로 페이지에 남는 것은 없다.
export const DRAW_MARKS = function (spec) {
  const old = document.getElementById("__ac_marks__"); if (old) old.remove();
  const root = document.createElement("div");
  root.id = "__ac_marks__";
  root.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  let n = 0;
  for (const b of spec.boxes || []) {
    const d = document.createElement("div");
    if (b.mask) {
      d.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background:#111;border-radius:3px;`;
      root.appendChild(d); continue;
    }
    n++;
    const c = b.color || "#FF3B6B";
    d.style.cssText = `position:absolute;left:${b.x - 3}px;top:${b.y - 3}px;width:${b.w + 6}px;height:${b.h + 6}px;`
      + `border:3px solid ${c};border-radius:5px;box-shadow:0 0 0 3px rgba(255,255,255,.75),0 4px 14px rgba(0,0,0,.35);`;
    root.appendChild(d);
    const tag = document.createElement("div");
    tag.textContent = b.label ? n + ". " + b.label : String(n);
    tag.style.cssText = `position:absolute;left:${b.x - 3}px;top:${Math.max(0, b.y - 31)}px;background:${c};color:#fff;`
      + "font:600 13px/1.5 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;padding:3px 9px;border-radius:5px;"
      + "white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35);max-width:70vw;overflow:hidden;text-overflow:ellipsis;";
    root.appendChild(tag);
  }
  if (spec.caption) {
    const cap = document.createElement("div");
    cap.textContent = spec.caption;
    cap.style.cssText = "position:fixed;left:0;right:0;bottom:0;background:rgba(10,22,32,.94);color:#EAF3FA;"
      + "font:500 14px/1.5 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;padding:11px 16px;"
      + "border-top:3px solid #FF3B6B;white-space:pre-wrap;";
    root.appendChild(cap);
  }
  document.body.appendChild(root);
  return n;
}.toString();
