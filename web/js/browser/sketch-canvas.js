// 스케치 오버레이. 캡처한 이미지를 깔고 그 위에 직접 그린다.
//
// 소유 범위
//   오버레이 DOM 과 팔레트, 그리기 엔진(펜·형광펜·사각형·화살표·글자·지우개·되돌리기), 확대·축소,
//   그리고 "그린 결과를 한 장의 PNG 로 합치는 일".
//
// 제공 API
//   openSketchCanvas({ png, width, height, onDeliver, onCancel, initialFit }). 오버레이를 띄우고, 사용자가
//   전달을 누르면 합친 PNG 바이트를 onDeliver 에 넘긴다. 이미 열려 있으면 아무 일도 하지 않는다.
//   처음에는 폭에 맞춰 열고, initialFit 이 "all" 이면 전체가 보이게 연다.
//
// 의존 대상
//   document 와 canvas 뿐이다. 서버도 네이티브도 모르며, 캡처와 전송은 부르는 쪽이 담당한다.
//
// 유지 조건
//   그리는 캔버스는 캡처한 이미지의 원래 크기(px)로 둔다. 화면에 맞춰 줄여서 그리면 합칠 때
//   선이 흐려지고 좌표가 어긋난다. 보이는 크기는 배율 하나로 폭과 높이를 함께 정하고, 좌표만
//   원래 크기로 환산한다. 폭과 높이를 따로 제한하면 한쪽만 줄어 그림이 찌그러진다.
//   되돌리기는 획 목록을 다시 그린다. 캔버스 스냅샷을 쌓으면 긴 페이지에서 메모리가 부족해진다.
//   Esc 는 반드시 닫는다. 오버레이가 남으면 그 창 전체가 조작되지 않는다.
//   머리는 두 줄이고 첫 줄에는 도구를 두지 않는다. 그 줄에 맥 신호등 버튼이 있어, 한 줄로 두면
//   왼쪽 도구가 그 버튼과 겹쳐 둘 다 눌리지 않는다.
//
// 영향 범위
//   화면 이름은 web/css/32-sketch.css 가 가진다. 부르는 쪽은 browser/sketch.js 하나다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/sketch-canvas.js

// Mac 메모 마크업이 주는 만큼만. 색은 여섯, 굵기는 셋.
const COLORS = ["#e02020", "#f5a623", "#f8e71c", "#2fb344", "#2f6fed", "#111111"];
// 안내에 쓸 이름. 색값을 그대로 띄우면 사용자가 알아볼 수 없다.
const COLOR_NAMES = ["빨강", "주황", "노랑", "초록", "파랑", "검정"];
const PEN_WIDTHS = [3, 7, 14];
// 글자 크기는 화면에 보이는 px 로 고른다. 입력칸을 열 때 그 배율로 원래 크기로 환산한다.
const TEXT_SIZES = [14, 20, 32];
const TEXT_LINE = 1.25;
const textFont = (px) => `600 ${px}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif`;
const ZOOM_MAX = 4;
const TOOLS = [
  { id: "pen", label: "펜", glyph: "✏️" },
  { id: "marker", label: "형광펜", glyph: "🖍" },
  { id: "rect", label: "사각형", glyph: "▭" },
  { id: "arrow", label: "화살표", glyph: "↗" },
  { id: "text", label: "글자", glyph: "T" },
  { id: "erase", label: "지우개", glyph: "◻︎" },
];

let openEl = null;

// 획 하나를 그 캔버스에 그린다. 되돌리기가 목록을 다시 돌리므로 이 함수는 상태를 안 갖는다.
function drawStroke(ctx, s) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  if (s.tool === "marker") { ctx.globalAlpha = 0.35; ctx.lineCap = "butt"; }
  // 지우개는 그린 것만 지운다. 배경 이미지는 별도 레이어라 그대로 남는다.
  if (s.tool === "erase") ctx.globalCompositeOperation = "destination-out";
  const p = s.points;
  if (s.tool === "text") {
    ctx.fillStyle = s.color;
    ctx.font = textFont(s.size);
    ctx.textBaseline = "top";
    // 입력칸의 줄 높이 위쪽 여백만큼 내려 그린다. 그래야 입력하던 자리와 확정한 글자가 겹친다.
    const pad = (s.size * (TEXT_LINE - 1)) / 2;
    s.text.split("\n").forEach((line, i) => ctx.fillText(line, s.x, s.y + pad + i * s.size * TEXT_LINE));
  } else if (s.tool === "rect") {
    const a = p[0], b = p[p.length - 1];
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (s.tool === "arrow") {
    const a = p[0], b = p[p.length - 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(12, s.width * 3.5);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4));
    ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4));
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
    // 점 하나만 찍은 것도 보여야 한다. 선으로만 그리면 한 번 탭했을 때 아무것도 남지 않는다.
    if (p.length === 1) ctx.lineTo(p[0].x + 0.1, p[0].y + 0.1);
    ctx.stroke();
  }
  ctx.restore();
}

// 안내는 직접 그린다. OS 기본 title 은 이 오버레이 위에서 표시되지 않는다.
function button(cls, text, tip) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  if (tip) b.dataset.tip = tip;
  return b;
}

export function openSketchCanvas({ png, width, height, onDeliver, onCancel, initialFit }) {
  if (openEl) return false;

  const root = document.createElement("div");
  root.className = "sk-root";
  // 머리는 두 줄이다. 첫 줄은 맥 신호등 버튼이 있는 영역이라 도구를 두지 않는다. 한 줄로 두면
  // 왼쪽 도구가 그 버튼과 겹쳐 둘 다 눌리지 않는다.
  const head = document.createElement("div");
  head.className = "sk-head";
  const title = document.createElement("div");
  title.className = "sk-title";
  title.textContent = "화면 스케치";
  head.appendChild(title);
  const bar = document.createElement("div");
  bar.className = "sk-bar";
  const scroll = document.createElement("div");
  scroll.className = "sk-scroll";
  const stage = document.createElement("div");
  stage.className = "sk-stage";
  const bg = document.createElement("img");
  bg.className = "sk-bg";
  bg.src = png;
  const draw = document.createElement("canvas");
  draw.className = "sk-draw";
  draw.width = width; draw.height = height;
  root.tabIndex = -1;
  stage.append(bg, draw);
  scroll.appendChild(stage);
  root.append(head, bar, scroll);

  const ctx = draw.getContext("2d");
  const strokes = [];
  let tool = "pen", color = COLORS[0], sizeIdx = 1;
  let live = null;
  let scale = 1, fit = "width";
  let editor = null;

  const repaint = () => {
    ctx.clearRect(0, 0, draw.width, draw.height);
    for (const s of strokes) drawStroke(ctx, s);
    if (live) drawStroke(ctx, live);
  };

  // 팔레트. 어느 버튼이 켜져 있는지는 class 하나로만 말한다.
  const toolBtns = new Map();
  for (const t of TOOLS) {
    const b = button("sk-tool", t.glyph, t.label);
    b.addEventListener("click", () => {
      tool = t.id;
      for (const [id, el] of toolBtns) el.classList.toggle("on", id === tool);
      widthWrap.hidden = !(tool === "pen" || tool === "erase" || tool === "text");
      widthBtns.forEach((wb, i) => { wb.dataset.tip = `${tool === "text" ? "글자 크기" : "굵기"} ${i + 1}`; });
      stage.classList.toggle("sk-text-tool", tool === "text");
    });
    toolBtns.set(t.id, b);
    bar.appendChild(b);
  }
  toolBtns.get("pen").classList.add("on");

  const widthWrap = document.createElement("div");
  widthWrap.className = "sk-widths";
  const widthBtns = [];
  PEN_WIDTHS.forEach((w, i) => {
    const b = button("sk-width", "", `굵기 ${i + 1}`);
    const dot = document.createElement("i");
    dot.style.width = dot.style.height = Math.max(4, w) + "px";
    b.appendChild(dot);
    b.addEventListener("click", () => {
      sizeIdx = i;
      for (const other of widthBtns) other.classList.toggle("on", other === b);
    });
    widthBtns.push(b);
    widthWrap.appendChild(b);
  });
  widthBtns[1].classList.add("on");
  bar.appendChild(widthWrap);

  const colorWrap = document.createElement("div");
  colorWrap.className = "sk-colors";
  const colorBtns = [];
  COLORS.forEach((c, i) => {
    const b = button("sk-color", "", COLOR_NAMES[i] || c);
    b.style.background = c;
    b.addEventListener("click", () => {
      color = c;
      for (const other of colorBtns) other.classList.toggle("on", other === b);
    });
    colorBtns.push(b);
    colorWrap.appendChild(b);
  });
  colorBtns[0].classList.add("on");
  bar.appendChild(colorWrap);

  // 확대·축소. 배율은 화면 px / 원래 px 이고, 폭 맞춤과 전체 보기는 창 크기가 바뀌면 다시 맞춘다.
  const zoomWrap = document.createElement("div");
  zoomWrap.className = "sk-zoom";
  const zoomOut = button("sk-zbtn", "−", "축소(⌘-)");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "sk-zlabel";
  const zoomIn = button("sk-zbtn", "+", "확대(⌘=)");
  const fitW = button("sk-zbtn sk-zfit", "폭 맞춤", "폭에 맞춤(⌘0)");
  const fitA = button("sk-zbtn sk-zfit", "전체", "전체가 보이게");
  zoomWrap.append(zoomOut, zoomLabel, zoomIn, fitW, fitA);
  bar.appendChild(zoomWrap);

  const undo = button("sk-act", "되돌리기", "마지막 획 취소");
  undo.addEventListener("click", () => { commitText(); strokes.pop(); repaint(); });
  const cancel = button("sk-act", "취소", "Esc");
  const send = button("sk-act sk-send", "채팅으로 보내기", "그린 그림을 터미널로 보냅니다");
  bar.append(undo, cancel, send);

  // 화면에 줄여 보이더라도 좌표는 원래 크기로 환산한다. 그러지 않으면 그린 위치가 어긋난다.
  const at = (e) => {
    const r = draw.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (draw.width / r.width), y: (e.clientY - r.top) * (draw.height / r.height) };
  };

  const box = () => {
    const cs = getComputedStyle(scroll);
    return {
      w: Math.max(1, scroll.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      h: Math.max(1, scroll.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
    };
  };
  const fitScale = (mode) => {
    const b = box();
    const sw = b.w / width;
    // 원래 크기보다 크게 맞추지 않는다. 좁은 페이지가 흐리게 늘어난다.
    return Math.min(1, mode === "all" ? Math.min(sw, b.h / height) : sw);
  };
  const placeEditor = () => {
    if (!editor) return;
    const { el, x, y, size } = editor;
    el.style.left = `${x * scale}px`;
    el.style.top = `${y * scale}px`;
    el.style.font = textFont(size * scale);
    el.style.lineHeight = String(TEXT_LINE);
  };
  // anchor 는 화면 좌표. 확대 전후로 그 점 아래의 그림 위치가 그대로 남도록 스크롤을 옮긴다.
  const applyScale = (next, anchor) => {
    const min = Math.min(0.05, fitScale("all"));
    next = Math.min(ZOOM_MAX, Math.max(min, next));
    const sr = scroll.getBoundingClientRect();
    const a = anchor || { clientX: sr.left + scroll.clientWidth / 2, clientY: sr.top + scroll.clientHeight / 2 };
    const before = stage.getBoundingClientRect();
    const px = (a.clientX - before.left) / scale;
    const py = (a.clientY - before.top) / scale;
    scale = next;
    stage.style.width = `${width * scale}px`;
    stage.style.height = `${height * scale}px`;
    const after = stage.getBoundingClientRect();
    scroll.scrollLeft += after.left - (a.clientX - px * scale);
    scroll.scrollTop += after.top - (a.clientY - py * scale);
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    placeEditor();
  };
  const zoomBy = (factor, anchor) => { fit = null; applyScale(scale * factor, anchor); };
  const fitTo = (mode) => { fit = mode; applyScale(fitScale(mode)); };
  zoomIn.addEventListener("click", () => zoomBy(1.25));
  zoomOut.addEventListener("click", () => zoomBy(0.8));
  fitW.addEventListener("click", () => fitTo("width"));
  fitA.addEventListener("click", () => fitTo("all"));
  // 트랙패드 핀치와 ⌘+휠은 ctrlKey 가 붙은 wheel 로 들어온다. 그 밖의 휠은 스크롤로 둔다.
  scroll.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    // 마우스 휠 한 칸은 트랙패드보다 delta 가 훨씬 커서, 제한하지 않으면 몇 칸에 최대 배율까지 간다.
    zoomBy(Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.006), e);
  }, { passive: false });
  const onResize = () => { if (fit) applyScale(fitScale(fit)); };
  window.addEventListener("resize", onResize);

  // 글자 입력. 확정하면 획 목록에 들어가 되돌리기·지우개·합치기가 다른 획과 같게 처리한다.
  const commitText = () => {
    if (!editor) return;
    const ed = editor;
    editor = null;
    const text = (ed.el.innerText || "").replace(/\n+$/, "");
    ed.el.remove();
    if (text.trim()) { strokes.push({ tool: "text", color: ed.color, size: ed.size, x: ed.x, y: ed.y, text }); repaint(); }
  };
  const cancelText = () => {
    if (!editor) return;
    const ed = editor;
    editor = null;
    ed.el.remove();
  };
  const openEditor = (pt) => {
    const el = document.createElement("div");
    el.className = "sk-text";
    el.contentEditable = "plaintext-only";
    el.spellcheck = false;
    el.style.color = color;
    editor = { el, x: pt.x, y: pt.y, size: TEXT_SIZES[sizeIdx] / scale, color };
    placeEditor();
    el.addEventListener("blur", () => { if (editor && editor.el === el) commitText(); });
    stage.appendChild(el);
    el.focus();
  };

  draw.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (tool === "text") {
      e.preventDefault();
      commitText();
      const pt = at(e);
      // 누른 직후 브라우저가 포커스를 옮기므로, 입력칸 포커스는 그 뒤에 준다.
      setTimeout(() => { if (openEl === root) openEditor(pt); }, 0);
      return;
    }
    commitText();
    draw.setPointerCapture(e.pointerId);
    const w = PEN_WIDTHS[sizeIdx];
    live = { tool, color, width: tool === "marker" || tool === "erase" ? w * 3 : w, points: [at(e)] };
    repaint();
  });
  draw.addEventListener("pointermove", (e) => {
    if (!live) return;
    live.points.push(at(e));
    repaint();
  });
  const finish = () => { if (!live) return; strokes.push(live); live = null; repaint(); };
  draw.addEventListener("pointerup", finish);
  draw.addEventListener("pointercancel", finish);

  const close = () => {
    if (openEl !== root) return;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    root.remove();
    openEl = null;
  };
  // Esc 는 캡처 단계에서 잡는다. 오버레이가 남으면 그 창 전체가 조작되지 않는다.
  const onKey = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (editor && e.target === editor.el) {
      // 입력 중의 Esc 는 입력만 취소한다. ⌘Z 는 입력칸 안의 되돌리기로 둔다.
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); cancelText(); root.focus(); return; }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitText(); root.focus(); return; }
      if (!mod || !["=", "+", "-", "_", "0"].includes(e.key)) return;
    }
    // 페이지 확대 단축키와 같은 키다. 오버레이가 열려 있으면 뒤의 탭이 아니라 스케치를 확대한다.
    if (mod && ["=", "+", "-", "_", "0"].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "0") fitTo("width"); else zoomBy(e.key === "-" || e.key === "_" ? 0.8 : 1.25);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); if (onCancel) onCancel(); return; }
    if (mod && (e.key || "").toLowerCase() === "z") {
      e.preventDefault(); e.stopPropagation(); strokes.pop(); repaint();
    }
  };
  document.addEventListener("keydown", onKey, true);
  cancel.addEventListener("click", () => { close(); if (onCancel) onCancel(); });

  send.addEventListener("click", async () => {
    commitText();
    send.disabled = true;
    send.textContent = "보내는 중…";
    try {
      const out = document.createElement("canvas");
      out.width = draw.width; out.height = draw.height;
      const octx = out.getContext("2d");
      octx.drawImage(bg, 0, 0, out.width, out.height);
      octx.drawImage(draw, 0, 0);
      const blob = await new Promise((res) => out.toBlob(res, "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      close();
      if (onDeliver) await onDeliver(bytes);
    } catch (e) {
      send.disabled = false;
      send.textContent = "채팅으로 보내기";
    }
  });

  openEl = root;
  document.body.appendChild(root);
  // 크기는 상자가 붙은 뒤에야 잴 수 있다. 포커스를 오버레이로 옮겨야 웹뷰가 확대 키를 가져가지 않는다.
  fitTo(initialFit === "all" ? "all" : "width");
  scroll.scrollTop = 0;
  root.focus();
  return true;
}

export function sketchOpen() { return !!openEl; }
