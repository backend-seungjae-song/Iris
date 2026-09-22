#!/usr/bin/env node
/* 메모랩 저장 계층을 실제로 돌려 보는 검사.

   소유 범위
     사람이 적은 것이 사라지는 경로가 막혀 있는가. 소스에 어떤 글자가 있는가가 아니라
     실제로 그 순서를 실행했을 때 조각이 남아 있는가를 확인한다.

   설계 이유
     이전 검사들은 전부 소스 모양만 확인했다. `renameSync` 가 있다는 사실은 실패했을 때
     원본이 남는다는 뜻이 아니고, `Store.ready.then` 이 있다는 사실은 모든 편집이 첫 읽기
 뒤에 시작된다는 뜻이 아니다. 그 검사 여덟이
     전부 통과하는 동안 아래 네 경로가 모두 열려 있었다.

   측정 방법
     store.js 를 그대로 import 한다. 브라우저 것(fetch·document·setInterval)만 부르기 직전에
     가짜로 갈아 끼우고, 회차마다 다른 질의로 새 모듈을 받는다. classic script 시절에는 소스를
     함수 몸으로 감쌌지만 모듈이 된 뒤로는 그럴 필요가 없다.
     서버 쪽은 상태 폴더를 임시 폴더로 돌린 뒤 실제 모듈을 호출한다. 사용자 파일은 건드리지 않는다.

   되돌려 확인할 것
     store.js 의 poll 에서 받아 온 것을 버리는 방어 조건(`if (rev !== atRev || dirty || ...)`)을
     통째로 지우면 1 과 2 가 실패해야 한다. 개별 항은 서로를 덮으므로 하나만 지워서는
 실패하지 않는다. 그 사실을 확인하고 적는다(확인 결과).
     put 안의 의문 처리를 지우면 6 이, orderOf 를 p.ord 로 되돌리면 7 이,
     ui 를 persist 로 되돌리면 8 이 실패해야 한다. */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
let judged = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));

function ok(name, cond, why) {
  judged += 1;
  if (cond) return;
  fails.push(`${name} — ${why}`);
}

/* store.js 를 가짜 환경에서 초기화한다. 돌려주는 것은 Store 와 그 환경의 핸들이다.

   앞 회차의 Store 를 먼저 정지시킨다. 모듈이 호출하는 fetch 는 호출 시점의 전역이라, 앞 회차가
   남긴 400ms 모아 보내기가 뒤 회차의 환경으로 들어온다. 그러면 8 이 앞 회차의 저장 3건 때문에
   실패한다. 함수 몸으로 감싸던 때는
   fetch 가 인자라 이 문제가 없었다. 갈아 끼우기 전에 그 시간만큼 기다린다. */
let boot = 0;
async function loadStore(seed) {
  if (boot) await new Promise((r) => setTimeout(r, 500));
  const world = {
    queue: [],          // 다음 fetch 가 쓸 응답 만들기
    poll: null,         // setInterval 이 받은 함수
    alerts: [],
    puts: [],
    views: [],       // 창 상태 파일로 나간 것
  };
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const fetchFake = async (url, init) => {
    /* 창 상태는 다른 파일이라 다른 응답을 준다. 한 줄로 묶어 두면 판을 기다리며
       세워 둔 응답을 창 상태 읽기가 가져가 회차가 엉뚱한 것을 측정한다. */
    if (String(url).startsWith("/memolab-ui")) {
      if (init && init.method === "PUT") {
        world.views.push(JSON.parse(init.body));
        return res({ ok: true });
      }
      return res(seed.view || { ui: {}, current: "inbox" });
    }
    if (init && init.method === "PUT") {
      const sent = JSON.parse(init.body);
      world.puts.push(sent);
      const make = world.queue.shift();
      return make ? make(url, sent) : res({ ok: true, rev: sent.rev + 1 });
    }
    const make = world.queue.shift();
    return make ? make(url) : res({ ok: true, rev: seed.rev, data: seed.data });
  };
  /* 브라우저 것만 갈아 끼운다. 모듈은 평가되는 순간 이것들을 잡으므로 import 보다 앞이어야
     한다. 회차마다 다른 질의를 붙여 새 모듈을 받는다. 그러지 않으면 첫 회차의 Store 하나가
     아홉 회차를 모두 처리한다. */
  globalThis.fetch = fetchFake;
  globalThis.alert = (m) => world.alerts.push(m);
  globalThis.document = { addEventListener() {}, hidden: false };
  globalThis.setInterval = (f) => { world.poll = f; return 0; };
  const url = new URL(`../web/memolab/store.js?r=${(boot += 1)}`, import.meta.url);
  const { Store } = await import(url.href);
  return { Store, world, res };
}

const board = (pieces = []) => ({ id: "inbox", title: "보관함", pieces, place: {}, cfg: {}, links: [] });
const snap = (pieces) => ({ boards: [board(pieces)], current: "inbox" });

/* 1. 받아 오는 사이에 적은 것이 안 사라진다.

   묻기 시작한 뒤에 이 창에서 조각을 만들었는데 다른 창의 응답이 도착하는 순서다.
   막지 않으면 그 조각이 아무 경고 없이 사라지고, rev 까지 새것으로 바뀌어
   서버의 409 가 막을 수 없다. */
async function raceDuringPoll() {
  const { Store, world, res } = await loadStore({ rev: 1, data: snap([]) });
  await Store.ready;

  let release;
  world.queue.push(() => new Promise((r) => { release = () => r(res({ ok: true, rev: 2, data: snap([]) })); }));
  const polling = world.poll();
  await tick();

  Store.addPiece("inbox", "받아 오는 사이에 적은 줄");
  release();
  await polling;
  await tick();

  const texts = Store.boards()[0].pieces.map((p) => p.text);
  ok("1 받아 오는 사이에 적은 것이 안 사라진다",
    texts.includes("받아 오는 사이에 적은 줄"),
    `조각이 사라졌다 — 지금 남은 것 ${JSON.stringify(texts)}`);
}

/* 2. 받아 오는 사이에 적고 저장까지 끝난 경우도 같다.

   이때는 dirty 가 다시 false 라서 「보낼 것이 남았는가」만 보는 방식으로는 못 막는다.
   세대(gen)가 필요한 이유가 이 회차다. */
async function raceAfterSave() {
  const { Store, world, res } = await loadStore({ rev: 1, data: snap([]) });
  await Store.ready;

  let release;
  world.queue.push(() => new Promise((r) => { release = () => r(res({ ok: true, rev: 3, data: snap([]) })); }));
  const polling = world.poll();
  await tick();

  Store.addPiece("inbox", "적고 저장까지 끝난 줄");
  world.queue.push(() => res({ ok: true, rev: 2 }));
  await new Promise((r) => setTimeout(r, 450));   // 모아 보내는 400ms 를 지나 보낸다

  release();
  await polling;
  await tick();

  const texts = Store.boards()[0].pieces.map((p) => p.text);
  ok("2 적고 저장까지 끝난 것도 안 사라진다",
    texts.includes("적고 저장까지 끝난 줄"),
    `조각이 사라졌다 — 지금 남은 것 ${JSON.stringify(texts)}`);
}

/* 3. 불러온 것이 일치하지 않으면 지금 판이 그대로 남는다.

   state 를 먼저 갈아 끼우고 판을 검사하면, 중간에 잘못된 판을 만났을 때
   오류를 내도 이미 현재 값을 지운 뒤이고 그다음 저장이 그 반쪽을 올린다. */
async function importStaysAtomic() {
  const { Store } = await loadStore({ rev: 1, data: snap([{ id: "p1", text: "원래 있던 줄" }]) });
  await Store.ready;

  let threw = false;
  try {
    Store.importJSON(JSON.stringify({ boards: [{ id: "a", pieces: [] }, { pieces: [] }] }));
  } catch (e) { threw = true; }

  const texts = Store.boards().flatMap((b) => b.pieces.map((p) => p.text));
  ok("3 불러오기가 어긋나면 지금 판이 남는다",
    threw && texts.includes("원래 있던 줄"),
    threw ? `지금 판이 이미 갈렸다 — 남은 것 ${JSON.stringify(texts)}` : "어긋난 파일을 그냥 받았다");
}

/* 4. 조각을 지우면 그것을 가리키던 자리도 없어진다.

   갈래에서는 칸 이름이 부모 조각의 id 다. 키로만 지우면 자식이 없는 부모를 가리킨 채
   남고, 갈래는 뿌리부터만 그리고 더미는 배치가 있는 것을 빼므로 어디에도 안 보인다. */
async function removeCleansReferences() {
  const { Store } = await loadStore({ rev: 1, data: snap([]) });
  await Store.ready;
  const parent = Store.addPiece("inbox", "부모");
  const child = Store.addPiece("inbox", "자식");
  Store.put("inbox", "tree", child.id, parent.id);
  Store.removePiece("inbox", parent.id);

  const left = Store.slots(Store.boards()[0], "tree");
  ok("4 지운 조각을 가리키던 자리도 없어진다",
    left[child.id] === undefined,
    `자식이 없는 부모를 가리킨 채 남았다 — ${JSON.stringify(left)}`);
}

/* 5. 서버가 rev 와 판 모양을 확인한 뒤에만 담는다.

   rev 를 보내지 않으면 충돌 검사를 건너뛰어, 빈 PUT 하나가 200 으로 통과하고 그다음 읽기가
   data:null 을 돌려준다. 정상 화면은 항상 rev 를 보내지만 그것을 보장하는 것은 화면이 아니라
   이 경계여야 한다. */
async function serverGuardsInput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memolab-check-"));
  /* 환경변수 이름을 여기서 다시 정의하지 않는다. 그 이름의 소유자는 server/env.cjs 하나이고,
     여러 곳이 각자 정의하면 빠뜨린 곳에서 개발 서버가 설치 앱의 폴더를 쓰게 된다. */
  const { childEnv } = createRequire(import.meta.url)(path.join(ROOT, "server/env.cjs"));
  Object.assign(process.env, childEnv({ port: 4271, stateDir: dir }));
  const mod = await import(`${path.join(ROOT, "server/memolab-store.js")}?t=${Date.now()}`);

  const good = { boards: [{ id: "inbox", pieces: [] }], current: "inbox" };
  ok("5a 빈 PUT 을 거절한다", mod.writeState(undefined, 0).ok === false, "빈 것이 담겼다");
  ok("5b rev 없는 쓰기를 거절한다", mod.writeState(good, undefined).ok === false, "rev 없이 담겼다");
  ok("5c 판 모양이 아니면 거절한다", mod.writeState({ boards: [] }, 0).ok === false, "빈 판이 담겼다");

  const first = mod.writeState(good, 0);
  ok("5d 제대로 된 것은 담는다", first.ok === true, `막혔다 — ${JSON.stringify(first)}`);
  ok("5e 어긋난 rev 는 거절한다", mod.writeState(good, 0).conflict === true, "낡은 rev 가 통과했다");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 9. 창 상태는 보낸 칸이 그대로 돌아온다.

   담는 쪽이 ui 칸만 꺼내고 current 를 버리면, 화면은 둘 다 보내고 둘 다
   읽으므로 새로 열 때마다 보던 판이 보관함으로 돌아간다. 보내는 칸과 담는 칸이
   일치하지 않으면 그 값은 경고 없이 사라진다. */
async function uiRoundTrip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memolab-ui-"));
  const { childEnv } = createRequire(import.meta.url)(path.join(ROOT, "server/env.cjs"));
  Object.assign(process.env, childEnv({ port: 4271, stateDir: dir }));
  const mod = await import(`${path.join(ROOT, "server/memolab-store.js")}?t=${Date.now()}u`);

  ok("9a 모양이 아니면 거절한다", mod.writeUI(null).ok === false, "빈 것이 담겼다");
  mod.writeUI({ ui: { mapZoom: 0.42 }, current: "b7" });
  const back = mod.readUI();
  ok("9b 취향이 그대로 돌아온다", back.ui && back.ui.mapZoom === 0.42, `다르다 — ${JSON.stringify(back)}`);
  ok("9c 지금 연 판도 그대로 돌아온다", back.current === "b7", `버려졌다 — ${JSON.stringify(back)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 6. 놓는 일과 그에 딸린 뒷일이 갈리지 않는다.

   의문 표시를 화면이 따로 호출해 붙이면 호출 위치 열여덟 곳 중 둘이 빠진다.
   더미로 뺀 조각의 표시가 남고, 바로 넣은 조각에는 붙지 않는다. */
async function putCarriesItsAftermath() {
  const { Store } = await loadStore({ rev: 1, data: snap([]) });
  await Store.ready;
  const a = Store.addPiece("inbox", "묻는 줄");
  const find = () => Store.boards()[0].pieces.find((p) => p.id === a.id);

  Store.put("inbox", "meet", a.id, "ask");
  ok("6a 의문 칸에 놓으면 표시가 선다", find().q === true, "표시가 안 섰다");

  Store.put("inbox", "meet", a.id, null);
  ok("6b 의문 칸에서 빼면 표시가 내려간다", find().q === false, "뺐는데 표시가 남았다");

  Store.put("inbox", "todo", a.id, "now");
  Store.setMeta("inbox", a.id, { q: true });
  Store.put("inbox", "todo", a.id, "done");
  ok("6c 다른 칸끼리 옮기는 것은 표시와 상관없다", find().q === true, "옮겼다고 표시가 꺼졌다");
}

/* 7. 칸 안의 순서는 분류마다 따로 센다.

   판 하나에 붙여 두면 할일에서 정한 순서가 묶음·공부의 같은 카드 순서까지
   함께 바꾼다. 같은 조각이 분류마다 다른 위치에 있는데 순서는 하나이기 때문이다. */
async function orderIsPerFrame() {
  const { Store } = await loadStore({ rev: 1, data: snap([]) });
  await Store.ready;
  const x = Store.addPiece("inbox", "첫 줄");
  const y = Store.addPiece("inbox", "둘째 줄");
  const b = () => Store.boards()[0];

  Store.setOrder("inbox", "todo", [y.id, x.id]);
  ok("7a 세운 분류에는 그 순서가 남는다",
    Store.orderOf(b(), "todo", y.id) < Store.orderOf(b(), "todo", x.id),
    "세운 순서가 안 남았다");
  ok("7b 다른 분류는 안 흔들린다",
    Store.orderOf(b(), "group", y.id) === Store.orderOf(b(), "group", x.id),
    "안 건드린 분류의 순서까지 갈렸다");
}

/* 8. 배율·접힘·지금 연 판은 판 문서로 안 나간다.

   이것들이 판 안에 있으면 배율만 바꿔도 조각 백 몇 장이 함께 올라가고,
   두 창이 다른 판을 보면 저장이 충돌해 한쪽이 멈춘다. */
async function viewStateStaysOutOfTheDocument() {
  const { Store, world } = await loadStore({ rev: 1, data: snap([{ id: "p1", text: "있던 줄" }]) });
  await Store.ready;
  world.puts.length = 0;
  world.views.length = 0;

  Store.ui("mapZoom", 0.42);
  Store.open("inbox");
  await new Promise((r) => setTimeout(r, 700));

  ok("8a 판 문서는 안 나간다", world.puts.length === 0,
    `취향만 바꿨는데 판이 ${world.puts.length}번 올라갔다`);
  ok("8b 창 상태 파일로 나간다", world.views.length > 0, "아무 데도 안 담겼다");
  ok("8c 담긴 것이 그 값이다",
    world.views.length > 0 && world.views[world.views.length - 1].ui.mapZoom === 0.42,
    `담긴 것이 다르다 — ${JSON.stringify(world.views[world.views.length - 1])}`);
}

/* 10. 판 문서가 창 상태를 안 싣는다.

   8 은 「취향만 바꿨을 때 판이 안 올라간다」를 확인하고, 이것은 「판이 올라갈 때 그 몸통에
   창 상태가 없다」를 확인한다. 둘은 다른 사실이다. 8 이 통과하는 동안에도 판 문서에
 allTabs·mapZoom 이 그대로 포함되어 나간 적이 있다. 원인은 옛 문서의
   ui 객체를 view.ui 로 그대로 이어 붙인 것이고, 두 이름이 한 객체를 가리키므로 취향을
   바꾸면 판 문서 쪽도 함께 바뀌어 다음 저장에 포함된다. */
async function documentCarriesNoViewState() {
  const old = { boards: [board([])], current: "inbox", ui: { mapZoom: 0.3, locbarOpen: false } };
  const { Store, world } = await loadStore({ rev: 1, data: old });
  await Store.ready;
  world.puts.length = 0;
  world.views.length = 0;

  Store.ui("mapZoom", 0.9);
  Store.addPiece("inbox", "판을 저장하게 만드는 줄");
  await new Promise((r) => setTimeout(r, 600));

  const sent = world.puts.filter((x) => x && x.data);
  ok("10a 판이 실제로 올라갔다", sent.length > 0, "안 올라가서 아무것도 못 쟀다");
  const body = sent.length ? sent[sent.length - 1].data : {};
  ok("10b 판 몸통에 창 상태가 없다",
    !("ui" in body) && !("current" in body),
    `실려 나간 칸 ${JSON.stringify(Object.keys(body))}`);
  ok("10c 옛 문서의 값을 안 건드린다", old.ui.mapZoom === 0.3, `옛 문서가 ${old.ui.mapZoom} 로 바뀌었다`);
  ok("10d 바꾼 값은 창 상태로 나간다",
    world.views.length > 0 && world.views[world.views.length - 1].ui.mapZoom === 0.9,
    `창 상태로 나간 것 ${JSON.stringify(world.views[world.views.length - 1] || null)}`);
}

const runs = [
  raceDuringPoll, raceAfterSave, importStaysAtomic, removeCleansReferences, serverGuardsInput,
  putCarriesItsAftermath, orderIsPerFrame, viewStateStaysOutOfTheDocument, uiRoundTrip,
  documentCarriesNoViewState,
];
for (const r of runs) {
  try { await r(); } catch (e) { fails.push(`${r.name} 이 돌다가 죽음 — ${e.message}`); }
}

if (fails.length) {
  console.error(`저장 계층 ${fails.length}건 실패`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`저장 계층 통과 — 회차 ${runs.length}, 판정 ${judged}`);
