// 탭 하나를 폰·패드처럼 보이게 하고, 되돌린다.
//
// 소유 범위
//   탭별 기기 등급·흉내 중인 기기·원래 UA·넘어가기 전 주소. 폭에서 등급을 정하는 기준과
//   등급별 UA·플랫폼·모델 프로필.
//
// 제공 API
//   createDeviceEmulation(deps) 가 apply(wc, args) · setTouchDrag(wc, on) · overrideFor(wcId) ·
//   hasExplicitDevice(wcId) · forget(wcId) 를 준다. 원시 표는 내주지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. 세션 명령은 주입받은 attach(wc) 가 돌려주는 send 로만 보내고,
//   사람이 정한 크기에 물러나는 것은 주입받은 yieldToExplicitViewport, UI 통지는 주입받은
//   notify 다. wc 는 호출자가 넘기는 webContents 이고 getURL·reload·loadURL·once 만 쓴다.
//
// 유지 조건
//   데스크톱으로 돌아갈 때 metrics·touch·mouse-to-touch·UA 를 전부 되돌린다. 하나라도 남으면
//   그 탭은 계속 모바일로 동작하고 사용자는 원인을 알 수 없다.
//   크기는 mobile:false 로 넣는다. true 면 뷰포트 meta 없는 페이지가 980 으로 고정돼 축소만 되고
//   미디어 쿼리가 적용되지 않는다.
//   터치를 끌 때 maxTouchPoints 를 같이 보내지 않는다. 명령이 통째로 거부돼 터치가 켜진 채 남는다.
//   마우스→터치 변환은 여기서 켜지 않는다. 그 명령만은 탭에 갇히지 않아 앱 헤더까지 적용된다.
//   사이트가 전용 모바일 주소로 옮겼으면 돌아올 때 원래 주소로 되돌리되, 그 사이 사용자가 다른 데로
//   갔으면 그 위치를 유지한다. 되돌리기는 우리가 옮긴 것만 되돌리는 것이다.
//
// 영향 범위
//   공급자는 cdp-control.cjs 의 ensureAttached·cdp-hidden-viewport 의 yield·main.cjs 의 viewportNotify 다.
//   양방향 소비자는 cdp-control 의 viewport·shotsizes 명령, main.cjs 의 ac-viewport IPC 와
//   google-auth-user-agent 의 URL별 UA 정책, 그리고 주소줄의 크기 버튼이다.
//   기기 base와 인증용 override를 분리해야 인증을 떠날 때 원래 기기 정체로 돌아간다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/cdp-device-emulation.cjs

const {
  clearDeviceUserAgentOverride,
  sendDeviceUserAgentOverride,
} = require("./google-auth-user-agent.cjs");

// 페이지는 폭만 보고 판단하지 않고 UA·터치·클라이언트 힌트도 함께 본다. 그래서 크기를 바꾸면
// 기기 성격도 그 크기에 맞게 따라간다. 폭 기준은 흔한 CSS 중단점을 그대로 쓴다.
// 경계는 실제 기기 폭에 맞춘다. 폰은 제일 큰 것(프로 맥스 430)까지, 패드는 세로 기준 제일 큰 것
// (아이패드 프로 11" 834)까지. 600·1024로 잡으면 1000px짜리 작은 노트북 창까지 패드로 분류돼
// 안드로이드 UA·터치가 적용된다.
function deviceClassFor(width) { return width <= 480 ? "phone" : width <= 840 ? "tablet" : "desktop"; }

// UA는 지금 쓰는 크롬 버전을 그대로 두고 플랫폼 문자열만 교체한다. 버전을 임의로 만들면 클라이언트
// 힌트와 일치하지 않아 오히려 눈에 띈다. 사파리(iOS) UA를 쓰지 않는 이유도 같다: 크롬 힌트와 맞지 않는다.
function deviceProfile(cls, baseUa) {
  const v = (String(baseUa || "").match(/Chrome\/([\d.]+)/) || [])[1] || "";
  if (cls === "phone") return { ua: `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Mobile Safari/537.36`, platform: "Android", platformVersion: "15", model: "Pixel 9", uaMobile: true };
  if (cls === "tablet") return { ua: `Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`, platform: "Android", platformVersion: "15", model: "SM-X910", uaMobile: false };
  return { ua: null, platform: "macOS", platformVersion: "15.0.0", model: "", uaMobile: false };
}

function uaBrands(baseUa) {
  const full = (String(baseUa || "").match(/Chrome\/([\d.]+)/) || [])[1] || "140.0.0.0";
  const major = full.split(".")[0];
  return { major, full, brands: [
    { brand: "Google Chrome", version: major }, { brand: "Chromium", version: major }, { brand: "Not/A)Brand", version: "24" },
  ] };
}

function createDeviceEmulation({ attach, yieldToExplicitViewport, notify }) {
  // 지금 흉내 내는 중인 탭. 나가는 요청의 sec-ch-ua-mobile/platform을 이 탭만 다르게 쓰기 위해
  // browser-hardening이 이 표를 본다. 헤더가 UA와 일치하지 않으면 흉내가 드러난다.
  const emulatedDevices = new Map();
  // 마지막으로 적용한 기기 등급. 등급이 바뀐 순간에만 새로고침한다(같은 등급 안에서 끄는 동안엔 안 함).
  const deviceClasses = new Map();
  // 폰·패드로 넘어갈 때 어디에 있었는지. 사이트가 전용 모바일 주소로 옮기면(naver.com →
  // m.naver.com) 거기서 새로고침해도 계속 모바일 페이지이고 UA를 되돌려도 풀리지 않는다(확인 결과).
  // 그래서 넘어가기 전 주소와 넘어간 주소를 함께 들고 있다가, 데스크톱으로 돌아올 때 되돌린다.
  const deviceEntry = new Map();   // wcId → { from, to }
  // 원래 UA. 해제할 때 되돌린다(CDP엔 UA 덮어쓰기를 지우는 명령이 없어 원래 값으로 되돌리는 것이 유일한 방법).
  const baseUserAgents = new Map();
  const webContentsById = new Map();

  function rememberDeviceEntry(wc) { try { deviceEntry.set(wc.id, { from: wc.getURL(), to: null }); } catch {} }

  // 넘어간 주소는 커밋 시점(did-navigate)에 잡는다. did-stop-loading은 하위 리소스까지 기다리느라
  // 늦어서, 그 사이 사용자가 다른 데로 가면 그 주소가 사이트가 옮긴 주소 자리에 들어간다.
  // 그러면 데스크톱으로 돌아갈 때 사용자가 보던 페이지를 원래 주소로 되돌려 버린다(재현 확인).
  function noteRedirect(wc) {
    wc.once("did-navigate", (_ev, url) => {
      const e = deviceEntry.get(wc.id);
      if (e && !e.to) e.to = url;
    });
  }

  // 데스크톱으로 돌아가기. 그 사이 사용자가 다른 데로 갔으면 그 위치를 유지하고 새로고침만 한다.
  // 되돌리기는 우리가 옮긴 것만 되돌리는 것이지 사용자의 이동을 취소하는 것이 아니다.
  function backToDesktop(wc) {
    const e = deviceEntry.get(wc.id);
    deviceEntry.delete(wc.id);
    let cur = ""; try { cur = wc.getURL(); } catch {}
    if (e && e.from && e.to && e.to !== e.from && cur === e.to) {
      try { wc.loadURL(e.from); return e.from; } catch {}
    }
    try { wc.reload(); } catch {}
    return null;
  }

  function overrideFor(wcId) { return emulatedDevices.get(Number(wcId)) || null; }
  function hasExplicitDevice(wcId) { return deviceClasses.has(Number(wcId)); }

  function forget(wcId) {
    const id = Number(wcId);
    const wc = webContentsById.get(id);
    if (wc) clearDeviceUserAgentOverride(wc);
    emulatedDevices.delete(id);
    deviceClasses.delete(id);
    deviceEntry.delete(id);
    baseUserAgents.delete(id);
    webContentsById.delete(id);
  }

  // 마우스→터치 변환 켜고 끄기. 창 전체에 걸리는 명령이라 "지금 그 화면 위에 포인터가 있는가"에
  // 묶어 둔다. 켠 채로 남기면 헤더·다른 탭 커서까지 터치가 된다.
  async function setTouchDrag(wc, on) {
    try {
      const send = attach(wc);
      await send("Emulation.setEmitTouchEventsForMouse", on ? { enabled: true, configuration: "mobile" } : { enabled: false });
      return { ok: true, on: !!on };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function apply(wc, args) {
    webContentsById.set(wc.id, wc);
    const send = attach(wc);
    yieldToExplicitViewport(wc.id);   // 사람이 정한 크기가 우선이다. 대신 넣어 준 값은 물러난다
    args = args || {};
    // WebContents UA는 Google auth 중 Firefox일 수 있다. viewport의 영구 base는 session 정체다.
    const baseUa = baseUserAgents.get(wc.id) || wc.session?.getUserAgent?.() || wc.getUserAgent();
    const { full, brands } = uaBrands(baseUa);
    const restoreUa = async () => {
      const d = deviceProfile("desktop", baseUa);
      await sendDeviceUserAgentOverride(wc, send, { userAgent: baseUa, platform: "MacIntel",
        userAgentMetadata: { brands, fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === "Not/A)Brand" ? "24.0.0.0" : full })),
          fullVersion: full, platform: d.platform, platformVersion: d.platformVersion, architecture: "arm", model: "", mobile: false } }).catch(() => {});
    };
    if (args.clear || String(args.size || "").toLowerCase() === "clear") {
      await send("Emulation.clearDeviceMetricsOverride");
      await send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
      await send("Emulation.setEmitTouchEventsForMouse", { enabled: false }).catch(() => {});
      if (baseUserAgents.has(wc.id)) { await restoreUa(); baseUserAgents.delete(wc.id); }
      clearDeviceUserAgentOverride(wc);
      emulatedDevices.delete(wc.id);
      const back = (deviceClasses.get(wc.id) || "desktop") !== "desktop";
      deviceClasses.delete(wc.id);
      // 폰·패드 페이지를 받아둔 상태면 데스크톱 페이지로 되돌린다. 사이트가 옮겨간 주소면 원래 주소로.
      const restoredUrl = back ? backToDesktop(wc) : null;
      if (!back) deviceEntry.delete(wc.id);
      if (notify) notify(wc.id, null);
      return { ok: true, cleared: true, reloaded: back, restoredUrl };
    }
    const width = Math.max(0, Math.round(Number(args.width) || 0));
    const height = Math.max(0, Math.round(Number(args.height) || 0));
    if (!width || !height) throw new Error("가로·세로를 주세요 (예: viewport 390 844, 해제는 viewport clear).");
    const cls = deviceClassFor(width);
    const d = deviceProfile(cls, baseUa);
    const dpr = Number(args.dpr) > 0 ? Number(args.dpr) : 0;   // 0 = 지금 화면 배율 그대로(억지 확대 금지)
    // ★ mobile:false로 넣는다. mobile:true면 크롬은 휴대폰 렌더링 규칙으로 그리는데, 뷰포트 meta가
    // 없는 페이지는 레이아웃 폭이 980으로 고정되고 그것을 지정한 폭으로 축소해 그린다. 어떤 크기를
    // 줘도 데스크톱 뷰가 축소된 것만 나오고 미디어 쿼리는 적용되지 않는다.
    // false면 레이아웃 폭이 정확히 지정한 폭이라 미디어 쿼리가 그대로 적용된다.
    // 기기 성격(UA·터치·클라이언트 힌트)은 아래에서 폭에 따라 따로 맞춘다.
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
    // 터치: 요즘 반응형은 폭보다 (pointer:coarse)·maxTouchPoints를 먼저 본다.
    // 끌 때는 enabled만 보낸다. maxTouchPoints:0을 같이 주면 명령이 통째로 거부돼 터치가 켜진 채
    // 남는다(확인 결과: 폰에서 데스크톱 크기로 옮겨도 maxTouchPoints 5, pointer:coarse 그대로였다).
    // 명령이 거부돼도 조용히 넘어가면 터치가 꺼지지 않은 상태가 그대로 남으므로,
    // 성공 여부를 결과에 실어 보낸다.
    const ok = async (cmd, params) => { try { await send(cmd, params); return true; } catch { return false; } };
    const touchOk = await ok("Emulation.setTouchEmulationEnabled",
      cls === "desktop" ? { enabled: false } : { enabled: true, maxTouchPoints: 5 });
    // 마우스→터치 변환은 여기서 켜지 않는다. 이 명령만은 탭에 갇히지 않기 때문이다. <webview>는 OS
    // 마우스 입력이 감싸는 창의 위젯을 거쳐 들어와서, 걸어두면 앱 헤더와 다른 탭까지 터치 커서가 된다.
    // 페이지 쪽 상태[크기·UA·maxTouchPoints]는 탭마다 분리되어 있음을 확인했고,
    // 커서를 바꾸는 것은 이것뿐이다. 그래서 포인터가 그 화면 안에 있는 동안만 켜며,
    // setTouchDrag를 렌더러가 mouseenter/leave·탭 전환에서 호출한다.
    const dragOk = cls !== "desktop";
    if (cls === "desktop") await ok("Emulation.setEmitTouchEventsForMouse", { enabled: false });
    if (!baseUserAgents.has(wc.id)) baseUserAgents.set(wc.id, baseUa);
    if (d.ua) {
      emulatedDevices.set(wc.id, { mobile: d.uaMobile, platform: d.platform });
      await sendDeviceUserAgentOverride(wc, send, { userAgent: d.ua, platform: "Linux armv8l",
        userAgentMetadata: { brands, fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === "Not/A)Brand" ? "24.0.0.0" : full })),
          fullVersion: full, platform: d.platform, platformVersion: d.platformVersion, architecture: "", model: d.model, mobile: d.uaMobile } }).catch(() => {});
    } else {
      emulatedDevices.delete(wc.id);
      await restoreUa();
    }
    // 기기가 바뀌면 새로고침한다. 크기만 바꿔서는 안 되는 사이트가 많다. 네이버처럼 서버가 UA를 보고
    // 다른 페이지(m.naver.com)를 주는 곳은 다시 받아야 모바일 뷰가 나온다. 확인 결과: naver.com의 뷰포트
    // meta는 `width=1190`이라 폭만 줄이면 데스크톱 페이지가 좁아질 뿐이다.
    // 끄는 중(live)에는 새로고침하지 않고 손을 놓았을 때 한 번만 한다.
    const prev = deviceClasses.get(wc.id) || "desktop";
    deviceClasses.set(wc.id, cls);
    const reloaded = prev !== cls && !args.live;
    let restoredUrl = null;
    if (reloaded) {
      if (prev === "desktop") { rememberDeviceEntry(wc); try { wc.reload(); } catch {} noteRedirect(wc); }
      else if (cls === "desktop") restoredUrl = backToDesktop(wc);
      else { try { wc.reload(); } catch {} }   // 폰↔패드는 자리를 그대로 두고 다시 받기만
    }
    if (notify) notify(wc.id, { w: width, h: height, cls });
    return { ok: true, width, height, device: cls, dpr, reloaded, restoredUrl,
      touch: cls !== "desktop" && touchOk, dragScroll: cls !== "desktop" && dragOk };
  }

  return { apply, setTouchDrag, overrideFor, hasExplicitDevice, forget };
}

module.exports = { createDeviceEmulation, deviceClassFor, deviceProfile, uaBrands };
