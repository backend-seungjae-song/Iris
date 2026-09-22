#!/usr/bin/env node
/* 판 목록을 실제로 나눠 보는 검사.

   소유 범위
     폴더와 날짜로 나눈 결과가 정한 규칙과 같은가. 무엇이 어느 묶음에 드는지,
     묶음이 어떤 순서로 나오는지, 보관함이 묶음 밖에 있는지.

   설계 이유
     이 규칙은 전부 순서와 소속이라 소스 모양으로는 안 보인다. `sort` 가 있다는 사실은
     최근이 위라는 뜻이 아니고, `folder` 를 읽는다는 사실은 폴더 없음이 맨 아래라는
     뜻이 아니다. 날짜 규칙은 틀려도 드러나지 않는다. 판이 엉뚱한 날짜에 들어가도
     화면은 정상으로 보인다.

   측정 방법
     web/memolab/group.js 를 그대로 import 한다. DOM 도 Store 도 안 보는 순수 계산이다.
     지금 시각은 인자로 넣는다. 날짜를 상수로 적으면 코드가 그대로여도 다음 날 실패한다.

   되돌려 확인할 것
     boardDay 가 created 를 먼저 보게 하면 1 이, 폴더 없음 순서 줄을 지우면 3 이,
     보관함을 rest 에 남기면 4 가, 폴더가 없을 때도 묶으면 5 가 실패해야 한다. */

import { boardDay, dayLabel, mergeFolder, railGroups } from "../web/memolab/group.js";

const fails = [];
let judged = 0;

function ok(name, cond, why) {
  judged += 1;
  if (cond) return;
  fails.push(`${name} — ${why}`);
}

/* 지금 시각을 하나 고정하고 모든 날짜를 그것에서 뺀다.

 "2026-09-09" 같은 날짜를 픽스처에 적으면 코드가 그대로여도 다음 날 실패한다. 여기서는
   NOW 만 고정이고 나머지는 전부 NOW 로부터의 며칠 전이라, 실제 시각이 흘러도 같은 것을
   측정한다. group.js 가 now 를 인자로 받는 이유가 이것이다. */
const NOW = new Date(2026, 8, 9, 15, 0, 0);
const dayBefore = (n) => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const at = (n, h = 9) => `${dayBefore(n)}T${String(h).padStart(2, "0")}:00:00.000Z`;

let seq = 0;
const board = (over) => ({
  id: `b${(seq += 1)}`, title: `판${seq}`, folder: "", created: at(30), pieces: [], ...over,
});
const names = (g) => g.groups.map((x) => x.label);
const rowsOf = (g, label) => (g.groups.find((x) => x.label === label) || { rows: [] }).rows.map((b) => b.title);

/* 1. 판의 날짜는 마지막으로 적은 날이다.

   닷새에 걸쳐 쌓은 판이 첫날로 분류되면 어제 이어 적은 것을 어제 묶음에서 찾을 수 없다. */
{
  const b = board({ created: at(11), pieces: [{ at: at(11) }, { at: at(2) }, { at: at(7) }] });
  ok("1a 마지막으로 적은 날을 쓴다", boardDay(b) === dayBefore(2), `${boardDay(b)} 가 나왔다`);
  const empty = board({ created: at(11), pieces: [] });
  ok("1b 아무것도 안 적은 판은 만든 날", boardDay(empty) === dayBefore(11), `${boardDay(empty)} 가 나왔다`);
}

/* 2. 오늘·어제만 이름으로 부른다. */
{
  ok("2a 오늘", dayLabel(dayBefore(0), NOW) === "오늘", dayLabel(dayBefore(0), NOW));
  ok("2b 어제", dayLabel(dayBefore(1), NOW) === "어제", dayLabel(dayBefore(1), NOW));
  ok("2c 그 밖은 날짜로", /^\d+월 \d+일$/.test(dayLabel(dayBefore(5), NOW)), dayLabel(dayBefore(5), NOW));
  ok("2d 다른 해는 해까지", dayLabel("2024-03-02", NOW) === "2024년 3월 2일", dayLabel("2024-03-02", NOW));
}

/* 3. 폴더 묶음은 최근이 위, 폴더 없음은 맨 아래. */
{
  const boards = [
    board({ id: "inbox", title: "보관함" }),
    board({ title: "옛 폴더 판", folder: "옛것", pieces: [{ at: at(9) }] }),
    board({ title: "새 폴더 판", folder: "새것", pieces: [{ at: at(1) }] }),
    board({ title: "폴더 밖 판", pieces: [{ at: at(0) }] }),
  ];
  const g = railGroups(boards, "folder", "inbox", NOW);
  ok("3a 최근 폴더가 위", names(g)[0] === "새것", `순서 ${JSON.stringify(names(g))}`);
  ok("3b 폴더 없음이 맨 아래",
    names(g)[names(g).length - 1] === "폴더 없음",
    `순서 ${JSON.stringify(names(g))} — 폴더 밖 판이 오늘 것이어도 아래여야 한다`);
}

/* 4. 보관함은 어느 묶음에도 안 든다. */
{
  const boards = [
    board({ id: "inbox", title: "보관함", folder: "새것", pieces: [{ at: at(0) }] }),
    board({ title: "판A", folder: "새것", pieces: [{ at: at(1) }] }),
  ];
  const g = railGroups(boards, "folder", "inbox", NOW);
  ok("4a 보관함을 따로 내준다", g.inbox && g.inbox.id === "inbox", "보관함을 못 찾았다");
  const inside = g.groups.flatMap((x) => x.rows).map((b) => b.id);
  ok("4b 묶음 안에는 없다", !inside.includes("inbox"), `묶음 안에 ${JSON.stringify(inside)}`);
}

/* 5. 폴더가 하나도 없으면 안 묶는다.

   「폴더 없음」 하나만 있는 화면은 묶음이 아니라 목록에 머리글 하나가 붙은 것이다. */
{
  const boards = [board({ id: "inbox", title: "보관함" }), board({ title: "판A" }), board({ title: "판B" })];
  const g = railGroups(boards, "folder", "inbox", NOW);
  ok("5a 그냥 목록으로 준다", Array.isArray(g.flat) && g.flat.length === 2, `flat ${JSON.stringify(g.flat)}`);
  ok("5b 묶음은 비어 있다", g.groups.length === 0, `묶음 ${JSON.stringify(names(g))}`);
  // 날짜는 폴더가 없어도 항상 묶인다. 폴더와 달리 날짜는 사람이 만들지 않아도 존재한다
  const d = railGroups(boards, "date", "inbox", NOW);
  ok("5c 날짜는 그래도 묶는다", d.flat === null && d.groups.length > 0, "날짜인데 안 묶었다");
}

/* 6. 날짜 묶음도 최근이 위이고, 한 묶음 안도 최근이 위. */
{
  const boards = [
    board({ id: "inbox", title: "보관함" }),
    board({ title: "옛것", pieces: [{ at: at(4) }] }),
    board({ title: "오늘1", pieces: [{ at: at(0, 9) }] }),
    board({ title: "오늘2", pieces: [{ at: at(0, 18) }] }),
  ];
  const g = railGroups(boards, "date", "inbox", NOW);
  ok("6a 오늘이 맨 위", names(g)[0] === "오늘", `순서 ${JSON.stringify(names(g))}`);
  ok("6b 같은 날은 한 묶음", rowsOf(g, "오늘").length === 2, `오늘 ${JSON.stringify(rowsOf(g, "오늘"))}`);
}

/* 7. 판을 판 위에 겹쳤을 때 어느 폴더가 되는가.

   이 규칙이 틀려도 화면은 정상으로 보인다. 폴더가 하나 더 생기거나 다른 묶음에 붙을 뿐이라
   그 시점에는 보이지 않고 나중에 목록이 일치하지 않는 것으로만 나타난다. */
{
  const a = mergeFolder("강의", ["강의", "새 폴더"]);
  ok("7a 받는 판의 폴더로 들어간다", a.name === "강의" && !a.fresh, `${JSON.stringify(a)}`);

  const b = mergeFolder("", []);
  ok("7b 둘 다 없으면 새로 짓는다", b.name === "새 폴더" && b.fresh, `${JSON.stringify(b)}`);

  const c = mergeFolder("", ["새 폴더"]);
  ok("7c 쓰는 이름과 안 겹친다", c.name === "새 폴더 2", `${JSON.stringify(c)}`);

  const d = mergeFolder("", ["새 폴더", "새 폴더 2", "새 폴더 3"]);
  ok("7d 빈자리를 찾아 간다", d.name === "새 폴더 4", `${JSON.stringify(d)}`);

  const e = mergeFolder("  강의  ", []);
  ok("7e 앞뒤 빈칸은 이름이 아니다", e.name === "강의" && !e.fresh, `${JSON.stringify(e)}`);
}

if (fails.length) {
  console.error(`판 묶기 ${fails.length}건 실패`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`판 묶기 통과 — 판정 ${judged}`);
