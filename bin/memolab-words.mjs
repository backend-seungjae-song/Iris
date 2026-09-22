#!/usr/bin/env node
/* 마인드맵 가지를 실제로 뽑아 보는 검사.

   소유 범위
     자동으로 뽑은 가지가 후보로만 남는가. 사람이 빼고 합치고 이름 붙인 것이 조각이
     늘어난 뒤에도 그대로인가.

   설계 이유
     사람이 정한 것을 조각 목록에 연결하면 조각 한 장만 늘어도 키가 바뀌어
     전부 사라진다. 소스에 `cfg.word` 가 있다는 사실은 그것이 유지된다는 뜻이
     아니다. 실제로 조각을 더해 보고 남아 있는지 확인한다(사람의 선택은 재계산으로
     되돌리지 않는다).

   측정 방법
     web/memolab/words.js 를 그대로 import 한다. 그 모듈은 DOM 도 Store 도 안 보는 순수
     계산이라 앱을 켜지 않고도 호출할 수 있다. app.js 에서 그 구간을 기준점으로 잘라 낼
     필요가 없어진 것이 모듈로 분리한 값이다.

   되돌려 확인할 것
     wordMap 에서 `cf.drop.has(w)` 를 지우면 2 가, `canon` 을 지우면 3 이,
     `cf.name` 을 지우면 4 가, 키를 조각 목록으로 되돌리면 5 가 실패해야 한다. */

import { wordMap, wordsOf } from "../web/memolab/words.js";

const fails = [];
let judged = 0;

function ok(name, cond, why) {
  judged += 1;
  if (cond) return;
  fails.push(`${name} — ${why}`);
}

let seq = 0;
const piece = (text) => ({ id: `p${(seq += 1)}`, text, at: "2026-09-08T00:00:00.000Z" });
const board = (texts, word) => ({ id: "b1", title: "판", pieces: texts.map(piece), cfg: word ? { word } : {} });
const words = (b) => wordMap(b).hubs.map((h) => h.word);

/* 1. 영문에 조사가 붙어도 한 낱말이다.

   「AI가」·「AI는」이 각각 다른 가지가 되고 「AI」는 두 글자라 빠지는 것을 막는다. */
{
  const got = [...wordsOf("AI가 좋다")];
  ok("1a 조사를 떼고 영문만 남는다", got.includes("ai"), `뽑힌 것 ${JSON.stringify(got)}`);
  ok("1b 붙은 형태로는 안 남는다", !got.includes("ai가"), `뽑힌 것 ${JSON.stringify(got)}`);
}

/* 2. 뺀 말은 가지가 안 된다. */
{
  const texts = ["측정 필요", "노출 필요", "측정 지표"];
  ok("2a 빼기 전에는 선다", words(board(texts)).includes("필요"), "원래부터 없다");
  ok("2b 뺀 말은 안 선다", !words(board(texts, { drop: ["필요"] })).includes("필요"), "빼도 그대로 선다");
}

/* 3. 합친 말은 한 가지가 된다. */
{
  const texts = ["광고 늘리기", "광고비 줄이기", "광고 집행", "광고비 계산"];
  const merged = wordMap(board(texts, { to: { 광고비: "광고" } })).hubs.find((h) => h.words.includes("광고"));
  ok("3 합친 쪽의 조각까지 한 가지에 걸린다",
    merged && merged.ids.length === 4, `걸린 조각 ${merged ? merged.ids.length : "없음"}`);
}

/* 4. 사람이 붙인 이름이 이긴다. */
{
  const texts = ["기능 추가 필요", "기능 추가 검토"];
  const named = words(board(texts, { name: { 기능: "기능 요청" } }));
  ok("4 붙인 이름이 나온다", named.includes("기능 요청"), `나온 것 ${JSON.stringify(named)}`);
}

/* 5. 조각이 늘어도 사람이 고친 것이 그대로다.

   이 검사가 이 파일의 존재 이유다. 고친 것을 조각 목록에 연결하면 여기서
   조각 두 장이 늘어나는 순간 이름도 뺀 말도 모두 풀린다. */
{
  const cfg = { drop: ["필요"], name: { 측정: "측정 방법" } };
  const before = words(board(["측정 필요", "측정 지표"], cfg));
  const after = words(board(["측정 필요", "측정 지표", "측정 주기 정하기", "노출 필요"], cfg));
  ok("5a 늘리기 전에 이름이 붙어 있다", before.includes("측정 방법"), `나온 것 ${JSON.stringify(before)}`);
  ok("5b 조각이 늘어도 이름이 남는다", after.includes("측정 방법"), `나온 것 ${JSON.stringify(after)}`);
  ok("5c 조각이 늘어도 뺀 말이 안 돌아온다", !after.includes("필요"), `나온 것 ${JSON.stringify(after)}`);
}

/* 6. 고정한 말은 한 장뿐이어도 가지가 된다. */
{
  const texts = ["컨설팅 계속 맡길 이유", "노출 늘리기"];
  ok("6a 그냥은 안 선다", !words(board(texts)).includes("컨설팅"), "두 장 규칙이 안 돈다");
  ok("6b 고정하면 선다", words(board(texts, { keep: ["컨설팅"] })).includes("컨설팅"), "고정해도 안 선다");
}

if (fails.length) {
  console.error(`가지 뽑기 ${fails.length}건 실패`);
  for (const f of fails) console.error("  " + f);
  process.exit(1);
}
console.log(`가지 뽑기 통과 — 판정 ${judged}`);
