// worker 사본 · 원본 cdp-capture-tools.cjs 중 CDP 로 하는 촬영 도구 (waitRenderIdle · zoom · viewportClip · stitchFullPage · rectOf · pruneShots)
// 원본은 ⑧에서 지움
// 다른 점: rectOf 는 ref 를 메인 registry(ref.resolve)에서 읽고, 이어 붙이기(composeTiles)와 pixel 비교는 메인이 함 (img.stitch · img.diff · img.same)

export function createWorkerCaptureTools({ fs, path, resolveRef, composeTiles, now = Date.now }) {
  // 그리기가 끝난 뒤에 찍는다. 재조회·애니메이션 중에 찍으면 반쯤 그려진 화면이 증거로 남는다.
  // 두 프레임을 연달아 받고 문서 로딩 완료까지만 확인하며, 무한정 기다리지 않도록 상한을 둔다.
  async function waitRenderIdle(send, capMs) {
    const cap = Math.max(0, Math.min(3000, Number(capMs) == null ? 600 : Number(capMs)));
    if (!cap) return;
    try {
      await Promise.race([
        send("Runtime.evaluate", {
          expression: `new Promise((res) => { const done = () => requestAnimationFrame(() => requestAnimationFrame(res));
            if (document.readyState === "complete") done(); else addEventListener("load", done, { once: true }); })`,
          awaitPromise: true,
        }),
        new Promise((r) => setTimeout(r, cap)),
      ]);
    } catch {}
  }
  // 페이지에 걸린 확대(zoom·transform)는 캡처를 실패시킨다. 확인 결과: zoom 1.4 이상에서 캡처가
  // 계속 실패했다. 원래 배율로 찍고 찍은 뒤 이전 상태로 되돌리며, 고배율이 필요하면 dpr을 쓴다.
  const ZOOM_PROBE = `(() => { const b = document.body, h = document.documentElement;
    const s = { bz: b.style.zoom || "", hz: h.style.zoom || "", bt: b.style.transform || "" };
    const on = !!(s.bz && s.bz !== "1" && s.bz !== "100%") || !!(s.hz && s.hz !== "1" && s.hz !== "100%") || !!s.bt;
    return JSON.stringify({ ...s, on }); })()`;
  async function readZoom(send) {
    try { const r = await send("Runtime.evaluate", { expression: ZOOM_PROBE, returnByValue: true }); return JSON.parse(r.result.value); }
    catch { return { on: false }; }
  }
  async function setZoom(send, z) {
    try {
      await send("Runtime.evaluate", { expression: `(() => { document.body.style.zoom = ${JSON.stringify(z.bz || "")};
        document.documentElement.style.zoom = ${JSON.stringify(z.hz || "")};
        document.body.style.transform = ${JSON.stringify(z.bt || "")}; return 1; })()` });
    } catch {}
  }
  // 지금 보이는 영역(배율 캡처용 clip). captureBeyondViewport와 scale은 같이 못 쓰므로 화면 몫만.
  async function viewportClip(send) {
    const r = await send("Runtime.evaluate", {
      expression: "JSON.stringify({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,ratio:devicePixelRatio})", returnByValue: true,
    });
    try { return JSON.parse(r.result.value); } catch { return { x: 0, y: 0, width: 1280, height: 800, ratio: 1 }; }
  }
  // 전체 페이지는 화면 한 장씩 내려가며 찍어 이어 붙인다. 뷰포트 밖까지 그리게 하는
  // captureBeyondViewport도, 화면 크기를 문서 높이로 바꾸는 방법도 이 임베딩에서는 동작하지
  // 않는다. 합성 표면이 창 크기 그대로라 같은 화면이 반복된다(확인 결과: 3000px 페이지가
  // 뷰포트 한 장의 반복으로 나왔다). 화면 한 장 촬영은 안정적이므로 그 방법만 쓴다.
  async function stitchFullPage(send, { dpr, settle }) {
    const lm = await send("Page.getLayoutMetrics");
    const cs = lm.cssContentSize || lm.contentSize;
    const vv = lm.cssVisualViewport || lm.visualViewport || {};
    const W = Math.max(1, Math.round(cs.width));
    const H = Math.max(1, Math.round(cs.height));
    const vh = Math.max(120, Math.round(vv.clientHeight || (await viewportClip(send)).height));
    const vw = Math.max(1, Math.round(vv.clientWidth || W));
    // 찍힌 장은 화면 배율만큼 큰 픽셀로 온다(2배 화면이면 두 배). 문서 좌표는 CSS 픽셀이므로
    // 그 비율을 측정해 이어 붙일 때 되돌린다. 측정하지 않고 붙이면 첫 장의 왼쪽 위 일부만 확대돼
    // 들어가고 나머지는 누락된다(확인 결과: 1710×1078 페이지가 왼쪽 위 864×542 만 담겼다).
    let px = 1;
    // 전체 페이지에는 배율을 얹지 않는다. 장마다 배율을 걸면 clip이 어긋나고, 화면 배율을 올리면
    // 첫 장만 원래 해상도로 와서 장 순서가 섞인다(확인 결과: 2800px 자리에 14번 다음 9번이 왔다).
    // 배율은 화면 한 장·요소 촬영에서만 쓰고, 전체는 원래 해상도로 담는다.
    const scale = 1;
    // 옮겨 놓고 바로 찍으면 아직 옮기기 전 화면이 찍힌다(확인 결과: 전체가 300px 밀려 나왔다).
    // 새 화면이 실제로 그려질 때까지 기다린 다음 그 위치를 다시 읽어 쓴다.
    const at = async (y) => {
      const r = await send("Runtime.evaluate", {
        expression: `new Promise((res) => { scrollTo(0, ${y});
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => res(scrollY), 120))); })`,
        awaitPromise: true, returnByValue: true,
      });
      await waitRenderIdle(send, settle);
      return Math.round((r.result && Number(r.result.value)) || 0);
    };
    const y0 = (await send("Runtime.evaluate", { expression: "scrollY", returnByValue: true }).catch(() => null));
    const back = Math.round((y0 && y0.result && Number(y0.result.value)) || 0);
    const tiles = [];
    let hid = false;
    try {

      let step = vh;
      for (let want = 0; want < H; want += step) {
        const y = await at(want);
        if (want > 0 && !hid) {
          // 두 번째 장부터는 화면에 붙어 다니는 것(고정 헤더·떠 있는 버튼)을 감춘다. 안 그러면 장마다
          // 겹쳐 찍혀 페이지에 그것이 여러 번 있는 것처럼 보인다. visibility라 자리는 그대로다.
          await send("Runtime.evaluate", { expression: `(() => {
            window.__acFixed = Array.prototype.filter.call(document.querySelectorAll("body *"), (e) => {
              const p = getComputedStyle(e).position; return p === "fixed" || p === "sticky"; });
            window.__acFixed.forEach((e) => { e.setAttribute("data-ac-vis", e.style.visibility || ""); e.style.visibility = "hidden"; });
            return window.__acFixed.length; })()` }).catch(() => {});
          hid = true;
        }
        // clip은 주지 않는다. 스크롤된 상태에서 clip을 주면 자를 위치가 어긋나 내용이 밀린다(확인 결과).
        // 배율은 아래에서 화면 배율 자체로 올려두므로 그냥 찍으면 그 해상도로 온다.
        // 한 장이라도 응답이 없으면 전체가 멈추므로(합성되지 않은 탭은 응답이 없다) 상한을 둔다.
        const r = await Promise.race([send("Page.captureScreenshot", { format: "png" }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("tile-slow")), 4000))]);
        // 화면 높이(innerHeight)와 실제로 찍힌 장의 높이는 다를 수 있다. 다르면 다음 장으로 내려갈
        // 간격이 어긋나 내용이 겹치거나 벌어지므로, 찍힌 장에서 직접 읽는다(PNG 머리 16~24바이트).
        const b0 = Buffer.from(r.data.slice(0, 64), "base64");
        const tw = b0.length >= 24 ? b0.readUInt32BE(16) : 0, th = b0.length >= 24 ? b0.readUInt32BE(20) : 0;
        if (tw > 0) px = Math.max(0.1, tw / vw);
        // 내려갈 간격도 CSS 픽셀이어야 한다. 장 높이를 그대로 쓰면 2배 화면에서 절반씩 건너뛴다.
        if (th > 0) step = Math.max(60, Math.round(th / (px * scale)));
        tiles.push({ y: Math.round(y * scale), d: r.data, th, tw });
        if (y + step >= H) break;               // 더 내려갈 곳이 없으면 끝
        if (tiles.length > 40) break;           // 끝없이 늘어나는 페이지 방어
      }
    } finally {
      if (hid) await send("Runtime.evaluate", { expression: `(() => { (window.__acFixed || []).forEach((e) => {
        e.style.visibility = e.getAttribute("data-ac-vis") || ""; e.removeAttribute("data-ac-vis"); });
        window.__acFixed = null; return 1; })()` }).catch(() => {});
      await send("Runtime.evaluate", { expression: `scrollTo(0, ${back})` }).catch(() => {});
    }
    const png = await composeTiles(tiles, W, H, px);
    return { png, info: { width: W, height: H, scale: 1, tiles: tiles.length,
      ...(dpr > 1 ? { note: "전체 캡처는 원래 해상도로 담습니다 — 배율은 화면 한 장이나 element 촬영에서 쓰세요." } : {}) } };
  }

  // 표시할 사각형(문서 좌표). ref면 CDP 박스 모델로, 선택자면 페이지에서 잰다. 못 찾으면 null.
  async function rectOf(send, wc, m) {
    if (m.ref) {
      const e = await resolveRef(m.ref);
      // 프레임 안 요소의 상자는 그 프레임 좌표계다. 창 좌표로 그리면 다른 위치에 표시되므로
      // 표시를 생략한다. 잘못된 위치를 가리키는 증거는 증거가 없는 것보다 나쁘다.
      if (e.sid) return null;
      const backendNodeId = e.backendDOMNodeId;
      await send("DOM.enable");
      const box = await send("DOM.getBoxModel", { backendNodeId });
      const q = box && box.model && box.model.border;
      if (!q) return null;
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if (!m.sel) return null;
    const r = await send("Runtime.evaluate", {
      // 판정이 여러 요소 중 특정 순번을 보고 내려졌으면 표시도 그 요소를 가리켜야 한다.
      // 첫 요소에 테두리를 치면 이미지가 판정과 다른 내용을 보여준다.
      expression: `(() => { const all = __acQA(${JSON.stringify(String(m.sel))});
        const el = all[${Number.isInteger(m.nth) ? Number(m.nth) : 0}] || all[0]; if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; })()`,
      returnByValue: true,
    });
    return (r.result && r.result.value) || null;
  }

  // QA 한 번에 스크린샷이 여러 장 쌓이고, 지우지 않으면 홈 디렉터리에서 계속 증가한다
  // (확인 결과: 하루 15장 2.5MB). 증거는 보고서에 포함되므로 최근 것만 남긴다.
  const SHOT_KEEP = 60;                    // 장수 상한
  const SHOT_MAX_AGE_MS = 7 * 24 * 3600e3; // 그리고 이보다 오래된 것
  let shotPrunedAt = 0;
  function pruneShots(dir) {
    const current = now();
    if (current - shotPrunedAt < 60e3) return;   // 찍을 때마다 디렉터리를 훑지 않게
    shotPrunedAt = current;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png"))
        .map((f) => { const fp = path.join(dir, f); try { return { fp, t: fs.statSync(fp).mtimeMs }; } catch { return null; } })
        .filter(Boolean).sort((a, b) => b.t - a.t);
      for (let i = 0; i < files.length; i++) {
        if (i >= SHOT_KEEP || current - files[i].t > SHOT_MAX_AGE_MS) { try { fs.unlinkSync(files[i].fp); } catch {} }
      }
    } catch {}
  }

  return { waitRenderIdle, readZoom, setZoom, viewportClip, stitchFullPage, rectOf, pruneShots };
}
