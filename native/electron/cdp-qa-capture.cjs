const { randomBytes } = require("node:crypto");
const { inIsolatedWorld } = require("./cdp-qa-login.cjs");
const { waitForWebStability } = require("./cdp-qa-stability.cjs");
const { zoomOf } = require("./cdp-qa-viewport.cjs");

function momentMark(rect, label) {
  const box = Array.isArray(rect) ? { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } : rect;
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) throw new Error("QA 순간 알림의 표시 영역이 올바르지 않습니다");
  return { ...box, label };
}

function inspectCapturePage() {
  const masks = [], seen = new Set();
  const visit = (doc, offsetX, offsetY) => {
    if (seen.has(doc)) return;
    seen.add(doc);
    for (const element of doc.querySelectorAll('input[type="password"]')) {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) masks.push({x:offsetX+box.x,y:offsetY+box.y,width:box.width,height:box.height});
    }
    for (const frame of doc.querySelectorAll('iframe')) {
      const box = frame.getBoundingClientRect(), css = getComputedStyle(frame);
      if (box.width <= 0 || box.height <= 0 || css.display === 'none' || css.visibility === 'hidden') continue;
      let child = null;
      try { child = frame.contentDocument; } catch {}
      if (child) visit(child, offsetX+box.x+(frame.clientLeft||0), offsetY+box.y+(frame.clientTop||0));
      else masks.push({x:offsetX+box.x,y:offsetY+box.y,width:box.width,height:box.height});
    }
  };
  visit(document,0,0);
  return {dpr:window.devicePixelRatio,masks};
}

function imageRenderer(BrowserWindow) {
  return async (png, options) => {
    const window = new BrowserWindow({ show: false, width: 64, height: 64,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await window.loadURL("data:text/html,<html><body></body></html>");
      const result = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = ${JSON.stringify("data:image/png;base64," + png.toString("base64"))}; await image.decode();
        const options = ${JSON.stringify(options)}, scale = options.scale;
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image,0,0);
        for (const box of options.boxes) {
          const x = (box.x-options.origin.x)*scale, y = (box.y-options.origin.y)*scale;
          ctx.fillStyle = box.mask ? '#111111' : box.color || '#c0392b'; ctx.strokeStyle = box.color || '#c0392b'; ctx.lineWidth = 3*scale;
          if (box.mask) ctx.fillRect(x,y,box.width*scale,box.height*scale);
          else { ctx.strokeRect(x,y,box.width*scale,box.height*scale); if (box.label) { ctx.font = 14*scale+'px sans-serif'; ctx.fillText(box.label,x+4*scale,y+18*scale); } }
        }
        if (options.caption) { ctx.fillStyle = '#111111'; ctx.fillRect(0,0,canvas.width,32*scale); ctx.fillStyle = '#ffffff';
          ctx.font = 14*scale+'px sans-serif'; ctx.fillText(options.caption,8*scale,22*scale,canvas.width-16*scale); }
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      return Buffer.from(result, "base64");
    } finally { window.destroy(); }
  };
}

function createQaCaptureCommands({ fs, path, shotsDir, nativeImage, renderImage, captureHold, observation, refRegistry,
  waitForStability = waitForWebStability, redact = (_id, value) => value }) {
  const rectFor = async (send, wc, spec) => {
    if (typeof spec === "string") spec = { sel: spec };
    if (spec && [spec.x, spec.y, spec.width, spec.height].every(Number.isFinite)) return spec;
    if (spec?.ref) {
      if (!refRegistry) throw new Error("QA 촬영 ref 조회자가 없습니다");
      const entry = refRegistry.resolveRef(wc.id, spec.ref);
      if (entry.sid) throw new Error("다른 출처 iframe의 ref 표시는 화면 좌표로 지정하세요");
      const box = await send("DOM.getBoxModel", { backendNodeId: entry.backendDOMNodeId });
      const quad = box?.model?.border;
      if (!Array.isArray(quad) || quad.length !== 8) throw new Error("QA 촬영 ref의 크기를 확인할 수 없습니다");
      const xs = [quad[0],quad[2],quad[4],quad[6]], ys = [quad[1],quad[3],quad[5],quad[7]];
      return { x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),label:spec.label,color:spec.color };
    }
    if (!spec?.sel) throw new Error("QA 촬영 표시에는 좌표 또는 sel이 필요합니다");
    const result = await inIsolatedWorld(send, `(() => {
      const elements = Array.from(document.querySelectorAll(${JSON.stringify(spec.sel)})).filter(e => { const b = e.getBoundingClientRect(), c = getComputedStyle(e); return b.width > 0 && b.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; });
      const e = ${Number.isInteger(spec.nth) ? `elements[${spec.nth}]` : "elements.length === 1 ? elements[0] : null"};
      if (!e) return null; const b = e.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}; })()`);
    if (!result) throw new Error("QA 촬영 요소를 하나로 확인하지 못했습니다");
    return { ...result, label: spec.label, color: spec.color };
  };
  const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
  const captureImage = async (send, wc, args = {}) => {
    const dpr = args.dpr ?? 1;
    if (!Number.isFinite(dpr) || dpr < 1 || dpr > 3) throw new Error("QA 촬영 배율은 1~3이어야 합니다");
    const boxes = [];
    for (const spec of list(args.mark)) boxes.push({ ...await rectFor(send, wc, spec), mask: false });
    for (const spec of list(args.mask)) boxes.push({ ...await rectFor(send, wc, spec), mask: true });
    // 비밀번호 칸은 요청 옵션과 관계없이 캡처 이미지에서 가림
    const secrets = await inIsolatedWorld(send, `(${inspectCapturePage.toString()})()`);
    if (!Array.isArray(secrets?.masks) || !(secrets.dpr > 0)) throw new Error("QA 비밀번호 가림 영역을 확인할 수 없습니다");
    boxes.push(...secrets.masks.map((box) => ({ ...box, mask: true })));
    const metrics = await send("Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport || metrics.visualViewport;
    if (!viewport?.clientWidth || !viewport?.clientHeight) throw new Error("QA 촬영 화면 크기를 확인할 수 없습니다");
    let crop = args.crop || (args.element ? await rectFor(send, wc, args.element) : null);
    if (args.full && crop) throw new Error("전체 촬영과 crop·element를 함께 쓸 수 없습니다");
    if (crop && (![crop.x,crop.y,crop.width,crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
      || crop.x+crop.width > viewport.clientWidth || crop.y+crop.height > viewport.clientHeight)) throw new Error("QA crop이 화면 밖입니다");
    const content = metrics.cssContentSize || metrics.contentSize;
    // 호스트 확대가 있으면 CSS 크기가 소수: 내림으로 결과 픽셀 수를 정수로 고정
    const area = args.full ? { x:0,y:0,width:Math.floor(content?.width),height:Math.floor(content?.height) } : crop || { x:0,y:0,width:Math.floor(viewport.clientWidth),height:Math.floor(viewport.clientHeight) };
    if (!(area.width>0 && area.height>0) || area.width*dpr > 16000 || area.height*dpr > 16000 || area.width*area.height*dpr*dpr > 64000000) throw new Error("QA 촬영 이미지 크기 상한 초과");
    const origin = args.full ? { x: -(viewport.pageX || 0), y: -(viewport.pageY || 0) } : area;
    const caption = redact(wc.id, String(args.caption || ""));
    let png, capturedAt;
      const result = await send("Page.captureScreenshot", { format:"png", captureBeyondViewport:!!args.full,
        clip:{...area,x:area.x+(args.full ? 0 : viewport.pageX || 0),y:area.y+(args.full ? 0 : viewport.pageY || 0),scale:dpr*zoomOf(wc)/secrets.dpr} });
      capturedAt = Date.now();
      png = Buffer.from(result?.data || "", "base64");
      if (!png.length) throw new Error("QA 촬영 이미지가 비어 있습니다");
      const size = nativeImage.createFromBuffer(png).getSize();
      if (size.width !== Math.round(area.width*dpr) || size.height !== Math.round(area.height*dpr)) throw new Error(`QA 촬영 결과가 요청한 크기와 다릅니다: 결과 ${size.width}×${size.height}, 요청 ${Math.round(area.width*dpr)}×${Math.round(area.height*dpr)}(영역 ${area.width}×${area.height}, 배율 ${dpr}, 페이지 배율 ${secrets.dpr})`);
      const masks = boxes.filter(box => box.mask);
      if (masks.length) png = await renderImage(png, { boxes:masks, caption:"", scale:dpr, origin });
    fs.mkdirSync(shotsDir, { recursive:true });
    const file = path.join(shotsDir, (args.moment ? "qa-moment-" : "qa-shot-") + randomBytes(12).toString("hex") + ".png");
    fs.writeFileSync(file,png);
    const marks = boxes.filter(box => !box.mask).map(box => ({label:box.label,color:box.color,
      x:(box.x-origin.x)/area.width,y:(box.y-origin.y)/area.height,w:box.width/area.width,h:box.height/area.height}));
    return { ok:true,path:file,capturedAt,tab:wc.id,captureTarget:{type:"tab",id:wc.id},url:wc.getURL(),title:wc.getTitle(),dpr,caption:caption || undefined,marks:redact(wc.id,marks),
      viewport:{width:viewport.clientWidth,height:viewport.clientHeight,dpr:secrets.dpr},
      fullPage:args.full ? {width:area.width,height:area.height} : undefined,via:"qa-read-only-capture" };
  };
  const screenshot = async (send, wc, args = {}) => {
    let held = false;
    try {
      held = captureHold ? await captureHold(wc.id, true) : false;
      const stability = args.stable === false || args.moment
        ? { waitedMs:0,stable:false,remaining:["not-requested"] }
        : await waitForStability(send, wc, { observation, timeoutMs:args.settle });
      return { ...await captureImage(send, wc, args), stability };
    } finally { if (held) await captureHold(wc.id, false); }
  };
  return {
    "qa-screenshot": screenshot,
    // 조작 직전 대기. 사진 촬영과 같은 조건(애니메이션·대기 요청·DOM 변경 없음), 상한 3초
    "qa-settle": (send, wc) => waitForStability(send, wc, { observation }),
    async "qa-observe"(send,wc,args={}) {
      const level=args.level || "error", limit=args.limit ?? 40;
      if (!["error","warn","all"].includes(level) || !Number.isInteger(limit) || limit<1 || limit>150) throw new Error("QA 진단 조회 범위가 올바르지 않습니다");
      const seen=observation.observe(wc.id,level,limit);
      const result={ok:true,url:wc.getURL(),title:wc.getTitle(),...seen};
      if(args.screenshot!==false) {
        const shot=await screenshot(send,wc,args); Object.assign(result,shot,{screenshot:shot.path});
      }
      return redact(wc.id,result);
    },
  };
}

module.exports = { createQaCaptureCommands, imageRenderer, momentMark, inspectCapturePage };
