// 창을 올리는 세 가지가 이 기기에서 실제로 되는지 확인한다. 다른 앱 창 올리기, 최소화 펼치기,
// 그리고 올린 뒤 다른 창들의 상대 순서가 그대로인지.
//
// 배경
//   ⌥Tab 창 전환기는 "고른 창만 앞으로 오고 나머지 순서는 그대로"를 약속한다. 그 약속은 접근성
//   API의 동작에 달려 있고 문서로는 확인되지 않아 기기에서 직접 봐야 한다.
//
// 무엇을 건드리는가
//   인자로 받은 앱의 창 하나를 잠깐 최소화했다 되돌리고 앞으로 올린다. 끝나면 원래 앞에 있던
//   앱으로 되돌린다. 대상은 반드시 자기가 띄운 개발 앱으로 준다. 사람이 쓰는 창을 대상으로
//   삼지 않는다.
//
// 실행 방법
//   node scripts/probe/window-raise.mjs "Electron" "Iris — 콘솔"
//   접근성 권한이 필요하다(이 프로세스를 띄운 터미널·앱).

import { execFile } from "node:child_process";

const [, , appName, winTitle] = process.argv;
if (!appName || !winTitle) {
  console.error('쓰는 법: node scripts/probe/window-raise.mjs "<앱 프로세스 이름>" "<창 제목>"');
  console.error('대상은 자기가 띄운 개발 앱이어야 한다. 사람이 쓰는 창을 대상으로 주지 않는다.');
  process.exit(2);
}

const SCRIPT = `
ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
function nap(s) { $.NSThread.sleepForTimeInterval(s); }
function onScreenOwners() {
  var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0);
  var arr = ObjC.castRefToObject(raw);
  var n = Number(arr.count), out = [];
  for (var i = 0; i < n; i++) {
    var w = ObjC.deepUnwrap(arr.objectAtIndex(i));
    if (w.kCGWindowLayer !== 0) continue;
    out.push(w.kCGWindowOwnerName + '#' + w.kCGWindowNumber);
  }
  return out;
}
function run(argv) {
  var q = JSON.parse(argv[0]);
  var se = Application('System Events');
  var out = { target: q };
  var prev = se.processes.whose({ frontmost: true })()[0].name();
  out.prev = prev;

  var ps = se.processes.whose({ name: q.app })();
  if (!ps.length) { out.error = '그 이름의 프로세스가 없다'; return JSON.stringify(out); }
  var proc = ps[0];
  var wins = proc.windows.whose({ name: q.title })();
  if (!wins.length) { out.error = '그 제목의 창이 없다'; return JSON.stringify(out); }
  var w = wins[0];

  out.zBefore = onScreenOwners().slice(0, 8);

  // 1) 최소화했다 속성 쓰기로 되돌린다.
  var r = {};
  try { w.attributes.byName('AXMinimized').value = true; } catch (e) { r.minErr = String(e); }
  nap(0.9);
  try { r.minimized = w.attributes.byName('AXMinimized').value(); } catch (e) { r.minReadErr = String(e); }
  try { w.attributes.byName('AXMinimized').value = false; } catch (e) { r.unminErr = String(e); }
  nap(0.9);
  try { r.stillMinimized = w.attributes.byName('AXMinimized').value(); } catch (e) {}
  out.unminimize = r;

  // 2) 올리기: 다른 앱에 포커스를 준 뒤 다시 올린다.
  try { se.processes.whose({ name: prev })()[0].frontmost = true; } catch (e) {}
  nap(0.7);
  var raise = {};
  try { w.actions.byName('AXRaise').perform(); proc.frontmost = true; } catch (e) { raise.err = String(e); }
  nap(0.7);
  var fp = se.processes.whose({ frontmost: true })()[0];
  raise.frontApp = fp.name();
  try { raise.frontTitle = fp.windows()[0].name(); } catch (e) { raise.frontTitle = ''; }
  raise.wanted = q.title;
  out.raise = raise;

  // 3) 올린 창 말고 다른 창들의 상대 순서가 그대로인가.
  out.zAfter = onScreenOwners().slice(0, 8);

  try { se.processes.whose({ name: prev })()[0].frontmost = true; } catch (e) {}
  return JSON.stringify(out);
}
`;

execFile("osascript", ["-l", "JavaScript", "-e", SCRIPT, JSON.stringify({ app: appName, title: winTitle })],
  { timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    if (err) {
      console.error("실패:", String(stderr || err.message || err).trim().slice(0, 300));
      process.exit(1);
    }
    let parsed;
    try { parsed = JSON.parse(String(stdout).trim()); } catch { console.log(String(stdout)); process.exit(0); }
    console.log(JSON.stringify(parsed, null, 2));
    const zb = (parsed.zBefore || []).filter((x) => !x.startsWith(appName + "#"));
    const za = (parsed.zAfter || []).filter((x) => !x.startsWith(appName + "#"));
    console.log("\n대상 말고 다른 창들의 상대 순서 보존:", JSON.stringify(zb) === JSON.stringify(za) ? "그대로" : "바뀜");
  });
