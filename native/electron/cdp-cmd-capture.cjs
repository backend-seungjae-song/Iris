// 화면 증거를 캡처·출력·비교하는 CDP command handler.
//
// 소유 범위
//   diff·screenshot·pdf·shotsizes의 촬영 순서, 원복 조건, 파일 응답.
//
// 제공 API
//   createCaptureCommands(ctx)가 명령 이름별 async handler 표를 준다. 원시 상태 컨테이너는 내주지 않는다.
//
// 의존 대상
//   조립부가 주입하는 layout/mark/zoom/capture/viewport/device/중첩 실행 포트와 fs/path/캡처 폴더,
//   명령마다 넘기는 CDP send·Electron webContents. Electron이나 cdp-control.cjs를 직접 require하지 않는다.
//
// 유지 조건
//   screenshot의 withLayout·hold·zoom·mark 원복, diff 임계값, shots 경로 정리와 shotsizes 마지막
//   clear를 보존한다. 비밀 화면 가림과 사람이 보던 탭 크기를 바꾸지 않는 계약을 유지한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 layout/capture helper·device emulation·WeakMap dispatcher 조립이다.
//   양방향 소비자는 cdp-control.cjs handler 표·default 안내, expect 중첩 촬영과 CLI/MCP 증거·PDF·반응형 흐름이다.

function createCaptureCommands({
  withLayout,
  rectOf,
  readZoom,
  setZoom,
  DRAW_MARKS,
  viewportClip,
  waitRenderIdle,
  captureHold,
  stitchFullPage,
  screencastShot,
  resetCdpSession,
  pruneShots,
  diffPng,
  samePng,
  deviceEmulation,
  cdpExecRaw,
  webContentsMod,
  fs,
  path,
  shotsDir,
}) {
  return {
    // 전후를 픽셀로 비교한다. 변경 여부를 이미지로 보이려면 세 번째 이미지가 필요하다.
    async diff(_send, _wc, args) {
      const a = String(args.before || ""), b = String(args.after || "");
      if (!fs.existsSync(a) || !fs.existsSync(b)) throw new Error("비교할 두 이미지 경로가 필요합니다(before·after).");
      const out = args.path ? String(args.path) : path.join(shotsDir, "diff-" + Date.now() + ".png");
      const res = await diffPng(a, b, out, Number(args.threshold) || 24);
      return { ok: true, path: out, changed: res.changed, total: res.total, ratio: res.ratio, note: res.note };
    },
    // 스크린샷은 촬영 사실이 아니라 결과를 알아볼 수 있는 증거여야 한다. 그래서 찍기 전에
    // 표시를 페이지 위에 직접 그린다(번호 뱃지·테두리·설명 띠). 찍은 뒤 남김없이 지워 페이지를
    // 원래 상태로 되돌린다. 가림(mask)은 비밀이 든 화면을 증거로 남길 때 쓴다.
    async screenshot(send, wc, args) { return await withLayout(send, async () => {
      const marks = Array.isArray(args.mark) ? args.mark : (args.mark ? [args.mark] : []);
      const masks = Array.isArray(args.mask) ? args.mask : (args.mask ? [args.mask] : []);
      const caption = args.caption == null ? "" : String(args.caption);
      // 좌표는 여기서 푼다. snapshot ref와 선택자를 같은 자리에서 받기 위해서다(ref는 페이지
      // 안에서 풀 수 없다). 페이지에는 그릴 사각형 목록만 넘긴다.
      const boxes = [], missing = [];
      for (const m0 of marks.concat(masks.map((s) => ({ sel: typeof s === "string" ? s : s.sel, ref: s && s.ref, mask: true })))) {
        const m = typeof m0 === "string" ? { sel: m0 } : (m0 || {});
        try {
          const rect = await rectOf(send, wc, m);
          if (rect) boxes.push({ ...rect, label: m.label ? String(m.label) : "", color: m.color ? String(m.color) : null, mask: !!m.mask });
          else missing.push(m.sel || m.ref);
        } catch (e) { missing.push((m.sel || m.ref) + " (" + ((e && e.message) || e) + ")"); }
      }
      // 페이지에 확대가 걸려 있으면 원래 배율로 찍고 끝나면 있던 대로 되돌린다. 배율은 dpr로 준다.
      const zoom = await readZoom(send);
      if (zoom.on) await setZoom(send, { bz: "", hz: "", bt: "" });
      let drew = null;
      // 전체 캡처 결과 정보(이어 붙인 크기·배율·장 수).
      let fullVp = null;
      if (boxes.length || caption) {
        const r0 = await send("Runtime.evaluate", {
          expression: `(${DRAW_MARKS})(${JSON.stringify({ boxes, caption })})`, returnByValue: true,
        });
        drew = { found: (r0.result && r0.result.value) || 0, missing };
      } else if (missing.length) drew = { found: 0, missing };
      try {
        let clip = null;
        if (args.element) {   // 그 요소만 찍는다. 화면 전체에서 어디를 봐야 하는지 찾지 않아도 된다
          const box = await send("Runtime.evaluate", {
            expression: `(() => { const el = __acQ(${JSON.stringify(String(args.element))}); if (!el) return null;
              const b = el.getBoundingClientRect(); const pad = 8;
              return { x: Math.max(0, b.left - pad), y: Math.max(0, b.top - pad), width: b.width + pad * 2, height: b.height + pad * 2, scale: 1 }; })()`,
            returnByValue: true,
          });
          clip = box.result && box.result.value;
          if (!clip) throw new Error(`요소를 찾지 못했습니다: ${args.element}`);
        }
        // 보이지 않는 창·탭은 OS와 크롬이 화면 그리기를 멈춘다. JS는 실행되지만 새 프레임이 나오지
        // 않으므로 합성 화면을 기다리는 기본 캡처는 25초를 소모하고 실패한다(확인 결과: 창이
        // 보이던 순간의 촬영만 성공). QA는 보고 있지 않은 탭도 찍어야 하므로 세 경로를 둔다.
        //   ① 기본(합성 화면, 화질 그대로) 6초  → ② fromSurface:false(합성 없이 렌더러에서) 5초
        //   → ③ Electron capturePage(창 단위, 다른 스페이스 창도 반환됨을 확인)
        // dpr을 주면 ①에서 clip.scale로 배율을 올린다. zoom 을 건드리면 오히려 캡처가 깨지므로
        // 그 방법은 쓰지 않는다.
        const dpr = Math.max(1, Math.min(3, Number(args.dpr) || 1));
        // 화면 몫 clip은 찍기 직전에 측정한다. hold 로 webview 크기가 바뀌면 그 전에 측정한 좌표는
        // 어긋난다(확인 결과: 미리 측정한 값으로 찍으니 같은 화면이 2×2로 반복됐다).
        const mkArgs = async () => {
          if (clip) return { format: "png", clip: { ...clip, scale: dpr } };
          if (dpr <= 1) return { format: "png" };
          const base = await viewportClip(send);
          const scale = Math.max(1, Math.min(dpr, 16000 / Math.max(base.width, base.height)));
          return { format: "png", clip: { ...base, scale } };
        };
        const race = (p, ms, tag) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(tag)), ms))]);
        await waitRenderIdle(send, args.settle);          // 반쯤 그려진 화면을 증거로 남기지 않는다
        let png = null, via = "surface";
        if (args.full && !clip) {
          // 이어 붙이는 동안은 탭을 합성 대상으로 붙잡아 둔다. 안 그러면 첫 장부터 응답이 안 온다.
          let sHeld = false;
          try { sHeld = captureHold ? await captureHold(wc.id, true) : false; } catch { sHeld = false; }
          try {
            const r0 = await stitchFullPage(send, { dpr, settle: args.settle });
            png = r0.png; via = "stitch"; fullVp = r0.info;
          } catch { png = null; }      // 못 이으면 아래 기존 경로가 화면 한 장이라도 남긴다
          finally { if (sHeld) { try { await captureHold(wc.id, false); } catch {} } }
        }
        // 보고 있는 탭이면 첫 줄에서 끝난다(빠른 길). 아니면 그 순간에만 합성 대상으로 붙잡고 다시 시도한다.
        let held = false;
        if (!png) {
        try {
          const r = await race(send("Page.captureScreenshot", await mkArgs()), 4000, "cdp-capture-slow");
          png = Buffer.from(r.data, "base64");
        } catch {
          {
          try { held = captureHold ? await captureHold(wc.id, true) : false; } catch { held = false; }
          try {
            const r = await race(send("Page.captureScreenshot", await mkArgs()), 4000, "cdp-held-slow");
            png = Buffer.from(r.data, "base64"); via = held ? "held" : "surface";
          } catch {
            try {
              const r2 = await race(send("Page.captureScreenshot", { ...(await mkArgs()), fromSurface: false }), 3000, "cdp-nosurface-slow");
              png = Buffer.from(r2.data, "base64"); via = "no-surface";
            } catch {
              try {
                png = await screencastShot(wc, 4000); via = "screencast";
              } catch {
                // 모두 실패하면 세션이 멈춘 것으로 본다. 끊지 않으면 다음 명령까지 함께 실패한다.
                resetCdpSession(wc); via = "capturePage";
                const img = await wc.capturePage(clip ? { x: Math.round(clip.x), y: Math.round(clip.y), width: Math.round(clip.width), height: Math.round(clip.height) } : undefined);
                png = img.toPNG();
              }
            }
          } finally {
            if (held) { try { await captureHold(wc.id, false); } catch {} }
          }
          }
        }
        }
        if (!png || !png.length) throw new Error("이 탭은 지금 화면에 그려지지 않아 찍을 수 없습니다 — 그 탭을 앞으로 한 번 꺼내고 다시 시도하세요.");
        // 녹화 경로는 직전 프레임과 같으면 파일을 만들지 않는다. 만들어 두고 나중에 제거하는
        // 방식은 디스크와 정리 부담이 그대로라, 촬영 시점에 판정한다.
        if (args.sameAs && samePng(String(args.sameAs), png)) {
          return { ok: true, path: String(args.sameAs), same: true, url: wc.getURL(),
            title: wc.getTitle(), via, dpr };
        }
        const dir = shotsDir;
        fs.mkdirSync(dir, { recursive: true });
        // 녹화 프레임은 회차 폴더로 바로 저장해 상태 폴더의 정리(60장·7일)가 증거를 지우지 않게
        // 한다. 정리는 상태 폴더에 쌓는 경우에만 동작한다.
        if (!args.path) pruneShots(dir);
        const p = args.path ? String(args.path) : path.join(dir, "shot-" + Date.now() + ".png");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, png);
        return { ok: true, path: p, url: wc.getURL(), title: wc.getTitle(), via, dpr,
          ...(fullVp ? { fullPage: fullVp } : {}),
          marked: drew ? drew.found : 0, missing: drew ? drew.missing : [], caption: caption || undefined,
          zoomRestored: zoom.on ? `${zoom.bz || zoom.hz || zoom.bt} (원래대로 되돌림 — 배율은 dpr을 쓰세요)` : undefined };
      } finally {
        if (drew) { try { await send("Runtime.evaluate", { expression: "(()=>{const n=document.getElementById('__ac_marks__');if(n)n.remove();return 1})()" }); } catch {} }
        if (zoom.on) await setZoom(send, zoom);
      }
    }); },
    // 지금 페이지를 인쇄 레이아웃 그대로 PDF 로 뽑는다. 스크린샷과 용도가 다르다. 스크린샷은 화면에
    // 보이는 픽셀이라 스크롤 밖이 잘리고 인쇄 전용 스타일(@media print)이 적용되지 않는다. 여러
    // 장짜리 표·주문서·영수증을 증거로 남길 때는 이쪽을 쓴다.
    // 화면에 그려지지 않는 탭에서도 동작한다. 인쇄는 합성 화면을 기다리지 않는다.
    async pdf(_send, wc, args) {
      const opt = {
        printBackground: args.background !== false,     // 배경색·배경이미지. 끄면 표 음영이 사라져 증거로 못 쓴다
        landscape: !!args.landscape,
        preferCSSPageSize: true,                        // 페이지가 @page 로 정한 크기를 존중한다
        ...(args.scale ? { scale: Math.min(2, Math.max(0.1, Number(args.scale) || 1)) } : {}),
        ...(args.pages ? { pageRanges: String(args.pages) } : {}),
      };
      // CDP 의 Page.printToPDF 는 Electron 의 webview 세션에 없다(확인 결과: "wasn't found").
      // Electron 은 같은 일을 webContents.printToPDF 로 제공하며 옵션 이름도 같다.
      const buf = await wc.printToPDF(opt);
      if (!buf || !buf.length) throw new Error("PDF를 만들지 못했습니다.");
      const dir = shotsDir;
      fs.mkdirSync(dir, { recursive: true });
      const p = args.path ? String(args.path) : path.join(dir, "page-" + Date.now() + ".pdf");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      return { ok: true, path: p, bytes: buf.length, url: wc.getURL(), title: wc.getTitle() };
    },
    // 반응형 확인은 폭을 바꿔가며 같은 화면을 보는 작업인데, 손으로 하면 크기 지정·대기·촬영·
    // 되돌리기를 매번 반복해야 한다. 한 번에 실행하고 원래 크기로 되돌린다.
    async shotsizes(_send, wc, args) {
      const PRESETS = { 모바일: [390, 844], mobile: [390, 844], 패드: [820, 1180], tablet: [820, 1180],
        데스크톱: [1440, 900], desktop: [1440, 900] };
      const want = (Array.isArray(args.sizes) && args.sizes.length ? args.sizes : ["모바일", "패드", "데스크톱"]);
      const shots = [];
      for (const s of want) {
        const key = String(s).trim();
        const wh = PRESETS[key] || (/^(\d+)x(\d+)$/.test(key) ? key.split("x").map(Number) : null);
        if (!wh) { shots.push({ size: key, error: "모르는 크기 — 모바일·패드·데스크톱 또는 1024x768 형식" }); continue; }
        await deviceEmulation.apply(wc, { width: wh[0], height: wh[1], dpr: Number(args.dpr) || 0 });
        await new Promise((r) => setTimeout(r, Number(args.settle) || 700));  // 반응형 전환이 끝날 틈
        const shot = await cdpExecRaw(webContentsMod(wc), wc.id, "screenshot", {
          caption: `${key} · ${wh[0]}×${wh[1]}${args.caption ? " — " + args.caption : ""}`,
          mark: args.mark, dpr: args.dpr,
        }).catch((e) => ({ error: String((e && e.message) || e) }));
        shots.push({ size: key, width: wh[0], height: wh[1], path: shot && shot.path, error: shot && shot.error });
      }
      await deviceEmulation.apply(wc, { clear: true });   // 남의 탭 크기를 바꿔놓고 끝내지 않는다
      return { ok: true, shots };
    },
  };
}

module.exports = { createCaptureCommands };
