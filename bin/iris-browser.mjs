#!/usr/bin/env node
// iris-browser: 터미널의 AI(Claude/Codex)가 Iris의 열린 브라우저(활성 탭)를 제어하는 CLI.
// Orca식: 앱이 webContents.debugger(CDP)로 임베드 webview를 직접 조종한다. 로컬(루프백) 전용.
//
// 사용:
//   iris-browser snapshot              현재 페이지의 접근성 스냅샷(요소 ref @e1… 포함). 먼저 실행한다
//   iris-browser click @e5             ref 요소 클릭 (snapshot 후)
//   iris-browser click "button.pay"    CSS 선택자로 클릭 (snapshot 불필요, 녹화 재현용)
//   iris-browser dblclick @e5          더블클릭
//   iris-browser goto google.com       URL 이동(다른 사이트로 넘어갈 때만. 같은 사이트 안은 눌러서 간다)
//   iris-browser type "안녕"           현재 포커스에 텍스트 입력
//   iris-browser key Enter             특수 키(Enter/Tab/Backspace…)
//   iris-browser eval "document.title" 페이지에서 JS 실행. 읽기만 가능(누르기·값 주입·이동은 서버가 거부)
//   iris-browser text                  본문 텍스트(innerText)
//   iris-browser screenshot            PNG 저장(경로 반환)
//   iris-browser url                   현재 URL/제목
//   iris-browser scroll down|up|top|bottom|<px>   페이지 스크롤(기본 down 한 화면)
//   iris-browser scrollto <y>          절대 위치로 스크롤(녹화 재현용. scroll은 상대 이동)
//   iris-browser viewport 390 844      탭 화면 크기 지정(반응형 확인). 배율은 세 번째 인자,
//                                    해제는 viewport clear. 주소줄의 [🖥 크기]와 같은 일이다.
//   iris-browser login [아이디]        저장된 로그인으로 이 페이지에 아이디/비번을 채운다. 앱의
//                                    [🔑 로그인]에서 허용한 (사이트, 아이디)만 가능하고, 비밀번호
//                                    값은 돌아오지 않으며 이 탭의 명령 결과에서도 가려진다.
//   iris-browser dialogs off           alert/confirm 자동 응답 해제(기본값. 사람이 보고 누른다)
//   iris-browser dialogs ok|cancel     이후 모든 대화상자를 확인/취소로 자동 응답
//   iris-browser dialogs ok,cancel,ok  뜨는 순서대로 자동 응답(녹화 재현용). 다 쓰면 다시 사람이 처리
//   iris-browser wait [ms]             로드 완료 대기(인자 없으면 readyState 완료까지, 최대 10s)
//   iris-browser back | forward | reload           히스토리 뒤로/앞으로/새로고침
//   iris-browser fill @e4 "검색어"      입력창(ref) 포커스+기존내용 대체 입력
//   iris-browser hover @e5             ref 요소 위로 마우스 이동(hover 메뉴 펼침)
//   iris-browser focus @e5             포커스만 준다(자동완성 목록·달력을 여는 데 쓴다)
//   iris-browser clear @e5             내용만 비운다(새 값은 넣지 않는다)
//   iris-browser check @e5 [off]       체크박스·라디오를 원하는 상태로 설정. 두 번 실행해도 같은 결과
//   iris-browser pdf                   지금 페이지를 인쇄 레이아웃 그대로 PDF로 저장
//   iris-browser select @e9 "옵션"      <select> 드롭다운에서 옵션(값/텍스트) 선택
//   iris-browser newtab [url]          이 세션 전용 탭을 만들고 자동 고정(병렬 작업용. 기본 구글)
//   iris-browser tabs                  열린 브라우저 탭 목록(wc·URL·제목) + 내 세션의 고정 상태
//   iris-browser target [@핸들]        인자 없으면 내 고정 조회, 있으면 그 탭에 고정
//   iris-browser untarget              고정 해제(이후 이 세션 그룹 안에서 마지막에 쓴 탭을 따름)
//   iris-browser --tab @핸들 click "…" 이 명령만 그 탭에서 실행(여러 탭을 오갈 때 고정 전환 없이)
//   iris-browser --tab @a,@b click "…"  여러 탭에 동시에(최대 4). 결과는 대상별로 나온다
//
// 탭 핸들(@스페이스-tab-난수)은 탭 정체성에 붙어 있어 앱을 재시작해도 같은 탭을 가리킨다. 스페이스
// 이름이 바뀌면 표시는 새 이름을 따르고 옛 이름으로 부른 것도 그대로 풀린다. 예전 wc 숫자도 아직
// 받지만 쓰지 않는 편이 좋다. wc는 webview가 다시 만들어질 때마다 재발급되어 다른 탭에 붙는다.
//
// 병렬 작업: 여러 세션이 한 탭을 서로 빼앗지 않도록 `newtab`으로 자기 탭을 만들어 쓴다. 만들어진 탭은
// 자기 스페이스에 백그라운드로 열리고(사용자 화면을 가로채지 않는다) 세션에 자동 고정된다. 고정은 탭
// 정체성에 묶여 있어 도킹/분리 전환이나 앱 재시작으로 webview가 다시 만들어져도 같은 탭을 계속 쓴다.
//
// 조작 범위: 이 세션이 소유한 *그룹* + 사용자가 앱에서 직접 지목해준 탭·그룹. 그 밖은 목록에도
// 나오지 않는다. 그룹이 없으면 첫 명령 때 그룹과 탭이 생긴다. 지목은 여러 개 쌓인다.
//
// 세션 식별: herdr가 pane마다 HERDR_PANE_ID를 주입한다. 고정은 이 값 기준이라 같은 머신의 다른
// 세션과 서로 간섭하지 않는다. 고정이 없으면 자기 그룹 안에서 마지막에 쓴 탭을 이어 쓴다.
import http from "node:http";
import { port as acPort } from "../server/env.cjs";

// --tab @5 : 이 명령만 그 탭에서 실행한다(고정을 갈아끼우지 않고 여러 탭을 오갈 때).
// 지목받았거나 자기 스페이스인 탭만 통과한다. 그 판정은 서버가 한다.
const argv = process.argv.slice(2);
let adhocTab = null;
// --reason "…" : 같은 사이트 안을 굳이 주소로 이동해야 할 때의 이유. 서버가 그 이동을 통과시키고
// 회차 기록에 "주소로 건너뜀"으로 남긴다. 눌러서 갈 수 있는 곳에는 쓰지 않는다.
let skipReason = null;
for (let i = 0; i < argv.length; i++) {
  // 쉼표로 여러 개(최대 4)를 줄 수 있다. 그룹으로 묶어둔 탭들에 같은 명령을 한 번에 실행한다.
  if (argv[i] === "--tab" && argv[i + 1] != null) { adhocTab = String(argv[i + 1]).split(",").map((t) => t.trim().replace(/^@/, "")).filter(Boolean).join(","); argv.splice(i, 2); i--; continue; }
  if (argv[i] === "--reason" && argv[i + 1] != null) { skipReason = String(argv[i + 1]); argv.splice(i, 2); i--; }
}
const [cmd, ...rest] = argv;
// 목록을 직접 적어두면 명령이 늘어도 그대로 남아, 있는 명령이 없는 것처럼 보인다(확인 결과:
// 다른 세션이 login·upload·nativeclick을 못 찾고 사람에게 넘겼다). 한 곳에 모아 도움말로 낸다.
const HELP = `사용법: iris-browser <명령> [인자]  (공통: --tab @핸들 로 이 호출만 다른 탭에서)

  보기      snapshot [--role R] [--name N] [--region R] [--cursor N] [--budget N]
            text · url · screenshot · observe · tabs
  이동      goto <url> · back · forward · reload · wait [ms]
            goto는 다른 사이트로 넘어갈 때만 — 같은 사이트 안은 눌러서 간다(서버가 거부).
            그 경로가 확인 대상이 아니면 goto <url> --reason "이유"
  조작      click · dblclick · hover · fill <대상> <값> · type <글> · key <키> · select <대상> <값>
            focus <대상> · clear <대상> · check <대상> [off]
            scroll <down|up|top|bottom|픽셀> · scrollto <y>
            eval <식>   읽기만 — 누르기·값 주입·이동은 위 조작 명령으로(서버가 거부)
  화면      viewport <가로> <세로> [배율]   탭 화면 크기 지정(반응형 확인) · viewport clear 해제
  로그인    login [아이디]        저장된 계정으로 아이디/비번 칸을 채운다(허용된 것만)
  파일      upload <경로…> · download <폴더|off> [once]
  창        dialog <ok|cancel> [값] · dialogs <off|ok|cancel|ok,cancel…>
            nativewin · nativeclick <버튼이름> · nativekey <escape|enter>
  탭        newtab [url] · target [@핸들] · untarget
  진단      cdpstate              이 탭의 CDP 부착 상태(attached·aiSession·identity·blocked). 부착 정책은 건드리지 않는다
  계획      plan check|digest|run <plan.json> [--run <회차>] [--only S1,S2] [--local]
            동결된 계획을 모델 없이 실행한다. 대상이 하나로 안 좁혀지면 고치지 않고 멈춘다.

대상은 스냅샷 참조(@e5) 또는 CSS 선택자. 탭은 핸들(@스페이스-tab-난수)로 부른다.`;
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); process.exit(cmd ? 0 : 2); }

// 계획 실행은 한 번의 요청이 아니라 여러 요청의 흐름이라 이 파일의 모양(한 명령 = 한 POST)에
// 맞지 않는다. 같은 이름으로 부르되 실행은 러너에 넘긴다.
if (cmd === "plan") {
  const { spawnSync } = await import("node:child_process");
  const runner = new URL("./qa-plan.mjs", import.meta.url).pathname;
  process.exit(spawnSync(process.execPath, [runner, ...rest], { stdio: "inherit" }).status ?? 1);
}

const arg = rest.join(" ");
const args = {};
switch (cmd) {
  // 인자가 @로 시작하면 snapshot ref, 아니면 CSS 선택자로 본다(녹화 재현 스크립트가 선택자를 쓴다).
  case "click": case "dblclick": {
    const a = rest.join(" ");
    if (a.startsWith("@")) args.ref = rest[0]; else args.sel = a;
    break;
  }
  case "goto": args.url = arg; if (skipReason) args.reason = skipReason; break;
  case "type": args.text = arg; break;
  case "key": args.key = rest[0] || "Enter"; break;   // "Shift+Enter"처럼 조합도 한 인자로
  case "eval": args.expression = arg; break;
  case "scroll": args.amount = rest[0] || "down"; break;
  case "scrollto": args.y = Number(rest[0] || 0); if (rest[1]) args.x = Number(rest[1]); break;
  // viewport 390 844 · viewport 390x844 · viewport clear
  case "viewport": {
    const a = rest.join(" ").trim();
    if (!a || a === "clear" || a === "off") { args.clear = true; break; }
    const m = a.match(/(\d+)\s*[x×*,\s]\s*(\d+)/);
    if (m) { args.width = Number(m[1]); args.height = Number(m[2]); }
    if (rest[2] && /^[\d.]+$/.test(rest[2])) args.dpr = Number(rest[2]);
    break;
  }
  case "dialogs": args.plan = rest[0] || "off"; if (rest[1]) args.text = rest[1]; break;
  // 큰 화면은 바이트 예산에서 끊긴다. 좁혀 보거나 커서로 이어 받는다. 전체를 다시 받으면 토큰만 늘어난다.
  case "snapshot": {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--role") args.role = rest[++i];
      else if (rest[i] === "--name") args.name = rest[++i];
      else if (rest[i] === "--region") args.region = rest[++i];
      else if (rest[i] === "--cursor") args.cursor = Number(rest[++i]);
      else if (rest[i] === "--budget") args.budget = Number(rest[++i]);
    }
    break;
  }
  case "upload": { const a2 = rest[0] || ""; if (a2.startsWith("@")) { args.ref = a2; args.paths = rest.slice(1); } else if (a2 && !a2.startsWith("/") && !a2.startsWith("~")) { args.sel = a2; args.paths = rest.slice(1); } else args.paths = rest; break; }
  case "download": args.dir = rest[0] || "off"; if (rest[1] === "once") args.once = true; break;
  case "nativeclick": args.button = rest.join(" "); break;
  case "nativekey": args["key"] = rest[0] || "escape"; break;
  case "dialog": args.answer = rest[0] || "cancel"; if (rest[1]) args.text = rest.slice(1).join(" "); break;
  case "login": if (rest[0]) args.username = rest.join(" "); break;
  case "wait": if (rest[0] && /^\d+$/.test(rest[0])) args.ms = Number(rest[0]); break;
  // 첫 인자가 @면 snapshot ref, 아니면 CSS 선택자(녹화 재현 스크립트가 선택자를 쓴다).
  case "fill": { const a = rest[0] || ""; if (a.startsWith("@")) args.ref = a; else args.sel = a; args.text = rest.slice(1).join(" "); break; }
  case "hover": { const a = rest.join(" "); if (a.startsWith("@")) args.ref = rest[0]; else args.sel = a; break; }
  // 포커스만 주기 / 비우기만 하기. fill 은 값까지 넣으므로 이 두 상태를 만들 수 없다.
  case "focus": case "clear": { const a = rest.join(" "); if (a.startsWith("@")) args.ref = rest[0]; else args.sel = a; break; }
  // 체크박스·라디오를 원하는 상태로. 값을 안 주면 켠다. 누르기와 달리 두 번 돌려도 같은 결과다.
  case "check": { const a = rest[0] || ""; if (a.startsWith("@")) args.ref = a; else args.sel = a;
    const v = (rest[1] || "").toLowerCase(); if (v) args.value = !(v === "off" || v === "false" || v === "0"); break; }
  case "select": { const a = rest[0] || ""; if (a.startsWith("@")) args.ref = a; else args.sel = a; args.value = rest.slice(1).join(" "); break; }
  case "target": if (rest[0]) args.tab = String(rest[0]).replace(/^@/, ""); break;
  // 스킴이 이미 있으면 그대로 둔다. http(s)만 통과시키면 file:·about: 주소 앞에 https://가
  // 덧붙어 "https://file///…"가 된다(확인 결과). 스킴이 없을 때만 https를 붙인다.
  // 사람을 부른다(결제·본인확인처럼 AI가 대신할 수 없는 경우).
  //   iris-browser ask "결제 수단을 골라 결제해 주세요" --wait 300
  case "ask": {
    const rs = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--wait") { args.wait = Number(rest[++i]) || 0; continue; }
      if (rest[i] === "--title") { args.title = rest[++i] || ""; continue; }
      if (rest[i] === "--ready") { args.ready = true; continue; }   // 내가 채울 수 있는 건 다 채웠다
      rs.push(rest[i]);
    }
    args.message = rs.join(" ");
    break;
  }
  case "newtab": {
    const rs = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--parallel" || rest[i] === "--new") { args.parallel = true; continue; }
      if (rest[i] === "--profile") { args.profile = rest[++i] || ""; args.parallel = true; continue; } // 계정이 다르면 저장 위치도 나뉜다
      rs.push(rest[i]);
    }
    if (rs[0]) args.url = /^[a-z][a-z0-9+.-]*:/i.test(rs[0]) ? rs[0] : "https://" + rs[0];
    break;
  }
  // 스크린샷은 증거다. 표시와 설명을 같이 넣을 수 있어야 사람이 보고 판단한다.
  //   iris-browser screenshot --mark ".pay:결제 버튼" --mark "@e5" --caption "결제 후 확인" --element "#total" --full
  case "screenshot": {
    args.mark = []; args.mask = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === "--caption") args.caption = rest[++i];
      else if (t === "--element") args.element = rest[++i];
      else if (t === "--full") args.full = true;
      else if (t === "--path") args.path = rest[++i];
      else if (t === "--mask") args.mask.push(rest[++i]);
      else if (t === "--mark") {
        const v = rest[++i] || "";
        const at = v.indexOf(":");                       // "선택자:설명" 형식이며 @ref도 같다
        const sel = at > 0 ? v.slice(0, at) : v, label = at > 0 ? v.slice(at + 1) : "";
        args.mark.push(sel.startsWith("@") ? { ref: sel, label } : { sel, label });
      }
    }
    if (!args.mark.length) delete args.mark;
    if (!args.mask.length) delete args.mask;
    break;
  }
}

// 세션 = herdr pane. IRIS_SESSION으로 덮어쓸 수 있다(herdr 밖 셸에서 특정 세션을 흉내낼 때).
const session = process.env.IRIS_SESSION || process.env.HERDR_PANE_ID || null;

if (adhocTab != null) args.tab = adhocTab;
const payload = JSON.stringify({ cmd, args, session });
const req = http.request(
  { host: "127.0.0.1", port: acPort(), path: "/browser-cmd", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
  (res) => {
    let body = ""; res.on("data", (c) => (body += c));
    res.on("end", () => {
      let r; try { r = JSON.parse(body); } catch { console.error("응답 파싱 실패:", body.slice(0, 200)); process.exit(1); }
      if (!r.ok) { console.error("오류:", r.error); process.exit(1); }
      const d = r.data || {};
      if (cmd === "snapshot") { if (d.humanHint) console.log(d.humanHint + "\n"); if (d.loginHint) console.log(d.loginHint + "\n"); if (d.url) console.log("URL:", d.url, "·", d.refCount, "refs" + (d.truncated ? ` · ${d.shown}/${d.lines}줄만` : "") + "\n"); console.log(d.snapshot || "(빈 스냅샷)"); }
      else if (cmd === "text") console.log(d.text || "");
      else if (cmd === "eval") console.log(typeof d.value === "string" ? d.value : JSON.stringify(d.value));
      else if (cmd === "tabs") {
        const list = d.tabs || [];
        if (!list.length) console.log("열린 브라우저 탭 없음");
        for (const t of list) console.log((t.handle && t.handle === d.pinned ? "* " : "  ") + ("@" + (t.handle || t.tabId)).padEnd(26) + (t.title || "(제목 없음)").slice(0, 40).padEnd(40) + "  " + (t.url || ""));
        console.log(d.pinned ? "\n* = 내 세션 고정 탭"
          : d.group ? `\n이 세션의 그룹: ${d.groupName || ""} (${d.group}) — 지정 없는 명령은 이 그룹 안에서만 돕니다.`
          : "\n이 세션은 아직 그룹이 없습니다 — 첫 명령 때 그룹과 탭이 생깁니다.");
        if (d.handleNote) console.log(d.handleNote);
      }
      else if (cmd === "ask") {
        console.log(d.answered ? "사람 응답: " + d.answer : "응답 없음");
        if (d.tab) console.log("탭 @" + d.tab);
        if (d.note) console.log(d.note);
      }
      else if (cmd === "newtab") {
        console.log(d.reused
          ? "쓰던 탭 @" + d.handle + " 사용 (스페이스 " + d.space + ")"
          : "탭 @" + d.handle + " 생성·고정 (스페이스 " + d.space + ")");
        console.log(d.url);
        if (d.note) console.log("\n" + d.note);
      }
      else if (cmd === "target" || cmd === "untarget") {
        if (!d.pinned) console.log("고정 없음" + (d.session ? " (세션 " + d.session + ")" : ""));
        else console.log("고정 @" + (d.handle || d.pinned) + "  " + ((d.tab && d.tab.title) || "") + "  " + ((d.tab && d.tab.url) || ""));
      }
      else console.log(JSON.stringify(d));
    });
  }
);
req.on("error", (e) => { console.error("연결 실패(앱·서버 실행 중?):", e.message); process.exit(1); });
req.write(payload); req.end();
