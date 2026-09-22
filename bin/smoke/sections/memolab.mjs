import { execFileSync } from "node:child_process";

import { cannotMeasure, check, checkAsync, filesUnder, read, ROOT, WEB_SHUTTLE_EXCLUDES } from "../core.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

// 메모랩 화면의 검사.
//
// 소유 범위
//   web/memolab 네 파일에 대한 판정. 문구 말투, 저장 경로, 로드 순서, 서버 쪽 짝의 존재.
//
// 의존 대상
//   core 의 read/check 와 bin/memolab-labels.mjs.
//
// 설계 이유
//   메모랩은 web 셔틀에서 제외된다(core.mjs 의 WEB_SHUTTLE_EXCLUDES). 앱 셸이 아니라
//   서버가 그대로 내주는 한 장짜리 화면이어서, 렌더러 말뭉치에 섞으면 무관한 음성 검사가
//   이 화면까지 검사한다. 제외만 하면 아무도 검사하지 않는 영역이 되므로,
//   제외한 만큼을 이 절에서 검사한다.

export default async function run() {
  console.log("[메모랩] 지면과 저장소");

  /* 이 절이 받는 말뭉치를 손으로 적지 않고 센다.

     셔틀에서 빼는 목록과 여기서 보는 목록이 각자 손으로 적혀 있으면 둘이 갈린다. 실제로
     그럴 자리였다. 지면에 파일 하나를 더하면 셔틀 제외에는 없어서 빨개지지만, 이 절은
 그 파일을 영영 안 본다. 세어서 대본다.*/
  const PAGE = "web/memolab";
  const pageFiles = filesUnder(PAGE, (rel) => /\.(?:html|js|css|mjs)$/.test(rel));
  if (pageFiles.length < 4) cannotMeasure(`지면 파일을 ${pageFiles.length} 개만 셌다 — 세는 방식이 깨졌다`);

  const store = read("web/memolab/store.js");
  const html = read("web/memolab/index.html");
  const app = read("web/memolab/app.js");

  /* 셔틀에서 제외한 만큼을 이 절이 검사한다.

     제외는 렌더러 말뭉치의 음성 검사가 무관한 화면을 검사하지 않게 하려는 것이고, 검사하지
     않는 영역을 만들려는 것이 아니다. 양쪽이 정확히 같은 집합인지 확인한다. 화면에 파일을
     더하면 제외 목록에 적게 하고, 제외 목록에만 남은 줄도 잡는다. */
  check("셔틀에서 뺀 지면은 이 절이 그대로 받는다", () => {
    const missing = pageFiles.filter((f) => !WEB_SHUTTLE_EXCLUDES.has(f));
    if (missing.length) throw new Error(`셔틀 제외에 없는 지면 파일: ${missing.join(", ")}`);
    const ghost = [...WEB_SHUTTLE_EXCLUDES].filter((f) => f.startsWith(`${PAGE}/`) && !pageFiles.includes(f));
    if (ghost.length) throw new Error(`없는 파일이 제외에 남아 있다: ${ghost.join(", ")}`);
    return true;
  });

  // 이 파일을 두는 이유가 이것 하나다. 브라우저 저장소로 되돌리면 주소가 달라질 때마다
  // 다른 판이 뜨고, 기기를 옮기면 내용이 남지 않는다.
  check("메모랩 저장은 서버 한 파일이다", () => {
    // 화면 전체를 본다. store.js 만 보면 화면 설정 같은 것이 다른 파일로 새어 나간다.
    // 실제로 레일 접힘 상태가 app.js 에서 브라우저 저장소로 빠져 있었다.
    for (const f of pageFiles) {
      if (/\b(?:local|session)Storage\s*[.[]/.test(read(f))) {
        throw new Error(`${f} 가 브라우저 저장소를 쓴다 — 저장은 서버 한 파일이다`);
      }
    }
    if (!store.includes("/memolab-state")) throw new Error("store.js 가 서버 저장소를 안 부른다");
    return true;
  });

  const assertRoute = async (pathname, name) => {
    const { capabilities } = await import(new URL("../../../server/capabilities.js", import.meta.url).href);
    const module = await import(new URL("../../../server/memolab-store.js", import.meta.url).href);
    const routes = capabilities.find((cap) => cap.id === "memolab")?.http || [];
    if (!/capabilityHost(?:\?\.|\.)http\(req, res, pathname\)/.test(read("server/http-handler.js"))) {
      throw new Error("http-handler 가 서버 기능 경로를 안 부른다");
    }
    if (typeof module[name] !== "function") throw new Error(`memolab-store 가 ${name} 처리기를 안 내준다`);
    for (const method of ["GET", "PUT"]) {
      if (!routes.some((route) => route.path === pathname && route.method === method && route.handler === module[name])) {
        throw new Error(`${method} ${pathname} 이 ${name} 처리기에 안 닿는다`);
      }
    }
  };

  // 창 상태는 판과 다른 파일이다. 한쪽만 고치면 취향 저장이 조용히 판을 덮는다.
  await checkAsync("창 상태는 판과 다른 주소로 나간다", async () => {
    if (!store.includes("'/memolab-ui'")) throw new Error("store.js 가 창 상태 주소를 안 쓴다");
    await assertRoute("/memolab-ui", "handleMemolabUI");
    return true;
  });

  /* 찾기는 판 전체를 대상으로 한다. 판 하나만 검색하면 어느 판에 적었는지 모를 때
     찾을 수 없어 다시 적게 된다. 결과를 잘랐을 때 그 사실을 알리는지도 함께 확인한다.
     알리지 않으면 잘린 결과가 전부인 것으로 읽힌다. */
  check("찾기는 판 전체를 훑고 자른 것을 말한다", () => {
    const rows = sliceBetween(app, "function findRows(q)", "\nfunction markHit");
    if (!/Store\.boards\(\)\.forEach/.test(rows)) throw new Error("판 하나만 훑는다");
    if (!/b\.pieces\.forEach/.test(rows)) throw new Error("조각을 안 훑는다");
    const draw = sliceBetween(app, "const draw = (q) =>", "const box = el(");
    if (!/rows\.length > FIND_SHOW/.test(draw)) throw new Error("자른 것을 말하지 않는다");
    if (!html.includes('id="btn-find"')) throw new Error("여는 자리가 지면에 없다");
    if (!app.includes("$('#btn-find').addEventListener")) throw new Error("그 자리가 아무것도 안 부른다");
    return true;
  });

  /* 자동으로 뽑은 가지는 후보다. 사람이 빼고 합치고 이름 붙인 것이 조각이 늘어난 뒤에도
     남아 있는지는 소스 모양으로는 안 보인다. 실제로 조각을 더해 보고 잰다. */
  check("사람이 고친 가지가 재계산에서 안 풀린다", () => {
    execFileSync(process.execPath, ["bin/memolab-words.mjs"], { cwd: ROOT, stdio: "pipe" });
    return true;
  });

  /* 접은 줄의 두 글자 규칙은 이름을 세지 않는다.

     한때 그 규칙이 판 단추와 새 판 단추를 이름으로 세고 있었고, 나중에 같은 모양으로
     들어온 찾기 단추가 어느 쪽에도 안 걸려 펼친 줄에서 「찾기찾」으로 보였다.
     이름을 세면 다음 단추에서 또 빠지므로 그 모양을 막는다. */
  check("접은 줄 규칙이 단추 이름을 세지 않는다", () => {
    const css = read("web/memolab/style.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = css.split("}").filter((r) => /\.(?:short|full)\b/.test(r));
    if (!rules.length) cannotMeasure("두 글자 규칙을 못 찾았다 — 세는 방식이 깨졌다");
    const named = rules.filter((r) => /#(?!rail\b)[\w-]+\s+\.(?:short|full)/.test(r));
    if (named.length) throw new Error(`이름으로 세는 규칙: ${named.map((r) => r.trim().split("\n")[0]).join(" · ")}`);
    // 줄 안의 것이면 전부 걸리는 규칙이 실제로 있는가
    if (!/#rail\s+\.short/.test(css)) throw new Error("줄 전체에 거는 규칙이 없다");
    return true;
  });

  /* 판을 무엇으로 묶는지는 전부 순서와 소속이라 소스 모양으로는 안 보인다.
     그리고 틀리면 조용하다. 판이 엉뚱한 날에 서 있어도 화면은 멀쩡하다. */
  check("판 묶기가 정한 규칙대로 나뉜다", () => {
    execFileSync(process.execPath, ["bin/memolab-groups.mjs"], { cwd: ROOT, stdio: "pipe" });
    return true;
  });

  /* 안 쓰는 분류를 접되 쓰기 시작하면 저절로 펴져야 한다. 이 되돌아오는 길이 없으면
     기본값이 한 번 틀린 순간 그 분류는 영영 안 보인다. */
  check("안 쓰는 분류만 접고 쓰면 편다", () => {
    const rule = sliceBetween(app, "const shows = (key, frame, isCur)", "const tab = (name, on, cur");
    if (!/used\(frame\)/.test(rule)) throw new Error("놓인 조각이 있어도 접힌다");
    if (!/isCur/.test(rule)) throw new Error("지금 열린 분류가 접힌다");
    if (!/allTabs/.test(rule)) throw new Error("사람이 펼 길이 없다");
    if (!/frame-tab more/.test(app)) throw new Error("펴는 자리가 화면에 없다");
    return true;
  });

  /* 접힘은 보는 사람의 사정이지 판의 내용이 아니다. 판 문서에 담으면 다른 창에서 접은 것이
     이 창을 접고, 접었다 폈다 하는 것마다 조각 백 몇 장이 통째로 올라간다. */
  check("접힘은 판이 아니라 창 상태에 담긴다", () => {
    /* 이름이 나오는 모든 줄을 본다. 따옴표 붙은 형태만 세면 `Store.cfg(b.id, 'study',
       { locShut: m })` 처럼 키로 넘기는 형태를 놓친다. 실제로 그 형태로 되돌려
       보니 이 검사가 그대로 통과했다. */
    for (const key of ["locShut", "allTabs"]) {
      const hits = app.split("\n").filter((ln) => new RegExp(`\\b${key}\\b`).test(ln) && !ln.trim().startsWith("*"));
      if (!hits.length) throw new Error(`${key} 를 아무도 안 쓴다`);
      let viaUi = 0;
      for (const ln of hits) {
        if (/Store\.(cfg|patchBoard|put|setMeta)\(/.test(ln)) {
          throw new Error(`${key} 가 판 문서로 나간다 — ${ln.trim()}`);
        }
        if (ln.includes("Store.ui(")) viaUi += 1;
      }
      if (!viaUi) throw new Error(`${key} 가 창 상태를 안 거친다`);
    }
    return true;
  });

  // 클라이언트가 부르는 주소를 서버가 실제로 받는가. 한쪽만 고치면 저장이 조용히 죽는다.
  await checkAsync("서버가 그 주소를 실제로 받는다", async () => {
    await assertRoute("/memolab-state", "handleMemolabState");
    return true;
  });

  // 쓰다가 끊긴 순간 원본이 반쪽으로 남으면 판이 통째로 사라진다.
  check("서버 저장은 임시 파일을 거쳐 rename 한다", () => {
    const src = read("server/memolab-store.js");
    if (!src.includes("renameSync")) throw new Error("rename 없이 곧바로 덮어쓴다");
    return true;
  });

  /* 이 검사가 서는 이유. 한 시간 분량이 사라졌는데 되돌릴 곳이 아무 데도
     없었다. rename 은 「반쪽이 안 남는다」만 지키고 「아까 것을 보고 싶다」는 못 지킨다.
     둘이 같은 것이라고 읽히기 쉬워서 검사로 강제해 둔다. */
  check("덮어쓰기 전에 이전본을 남긴다", () => {
    const src = read("server/memolab-store.js");
    if (!src.includes("memolab-history")) throw new Error("이전본을 남길 자리가 없다");
    if (!/function keepOld/.test(src)) throw new Error("이전본을 남기는 자리가 없다");
    // 기준점을 못 찾으면 예외를 던진다. indexOf 만 쓰면 -1 이 나와 아무것도 검사하지 않고 통과한다
    const w = sliceBetween(src, "export function writeState", "function send(", "writeState");
    const keep = w.indexOf("keepOld(");
    const ren = w.indexOf("renameSync");
    if (keep < 0) throw new Error("writeState 가 이전본을 안 남긴다");
    if (ren >= 0 && keep > ren) throw new Error("덮어쓴 뒤에 남기면 남는 것이 이미 새것이다");
    return true;
  });

  /* 무엇이 무엇보다 먼저 와야 하는지는 import 가 정한다.

     예전에는 classic script 둘을 순서대로 싣고 전역 이름으로 이었다. 화면에 파일이 하나
     늘 때마다 그 순서가 계약이 됐고, 순서를 지키는 것은 사람의 기억이었다. 모듈로 가르면
 그 계약이 사라진다. 그 사라진 상태를 검사로 고정해 둔다.*/
  check("지면은 모듈 하나로 실린다", () => {
    const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    const plain = tags.filter((t) => t.includes("src=") && !t.includes('type="module"'));
    if (plain.length) throw new Error(`전역 이름으로 잇는 script 가 남아 있다: ${plain.join(" ")}`);
    const mods = tags.filter((t) => t.includes('type="module"'));
    if (mods.length !== 1) throw new Error(`모듈 script 가 ${mods.length} 개 — 하나여야 한다`);
    if (!mods[0].includes("app.js")) throw new Error("싣는 모듈이 app.js 가 아니다");
    if (!/^import \{ Store \} from '\.\/store\.js';$/m.test(app)) {
      throw new Error("app.js 가 store 를 스스로 안 끌어온다");
    }
    return true;
  });

  // 곧바로 그리면 빈 판이 번쩍이고, 그 사이 한 줄이라도 적으면 받아 온 것이 그것을 지운다.
  check("서버에서 받아 온 뒤에 그린다", () => {
    if (!/Store\.ready\s*\.\s*then/.test(app)) throw new Error("app.js 가 Store.ready 를 안 기다린다");
    return true;
  });

  // 보기를 화면에만 더하면 판을 다시 열 때 migrate 가 place 키를 찾지 못해 다른 칸이 뜬다.
  // 단어 보기에서 실제로 발생했다. 표가 두 곳에 있는데 한쪽만 갱신했기 때문이다.
  check("보기마다 store 가 place 열쇠를 안다", () => {
    const store = read("web/memolab/store.js");
    const table = store.match(/const FRAME_OF = \{([^}]*)\}/);
    if (!table) throw new Error("store.js 에서 FRAME_OF 표를 못 찾음");
    const known = new Set([...table[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
    const block = app.match(/const VIEWS = \{([\s\S]*?)\n\};/);
    if (!block) throw new Error("app.js 에서 VIEWS 를 못 찾음");
    const views = [...block[1].matchAll(/^  (\w+): \{/gm)].map((m) => m[1]);
    if (views.length < 2) throw new Error("VIEWS 를 못 읽음 — 검사가 아무것도 안 재고 있다");
    const lost = views.filter((v) => v !== "box" && !known.has(v));
    if (lost.length) throw new Error(`store 가 모르는 보기: ${lost.join(", ")}`);
    if (/const FRAME_OF = \{/.test(app)) throw new Error("app.js 가 같은 표를 또 들고 있다");
    return true;
  });

  /* 여기까지는 전부 소스 모양을 본다. 그것만으로는 「사람이 적은 것이 안 사라진다」를
     못 잰다. 실제로 이 여덟이 전부 초록인 채로 받아 오는 사이의 편집이 사라지는 길이
 열려 있었다. 그 길은 돌려 봐야 보인다.*/
  check("저장 계층이 실제로 손실을 막는다", () => {
    execFileSync(process.execPath, ["bin/memolab-race.mjs"], { cwd: ROOT, stdio: "pipe" });
    return true;
  });

  check("메모랩 화면 문구가 라벨체다", () => {
    const out = execFileSync(process.execPath, ["bin/memolab-labels.mjs"], { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
    // 단어 검사를 건너뛴 통과는 부분 통과다. 통과에 묻히지 않게 note 로 남긴다.
    if (/건너뜀/.test(out)) console.log(`  note ${out.trim().split("\n").pop()}`);
    return true;
  });

  /* 화면에서 제거한 칸을 app.js 가 계속 참조하면 화면 전체가 동작하지 않는다.

     `$('#board-folder')` 는 칸이 없으면 null 을 반환하고, 거기에 addEventListener 를 붙이는
     줄이 모듈 최상위에서 실행되어 app.js 전체가 중단된다. 화면은 빈 뼈대만 남는데,
     소스 모양만 보는 검사는 호출 시점의 예외를 보지 못해 전부 통과한다.
     확인 결과: 폴더 입력칸을 제거한 뒤 판 목록이 비었다.

     그래서 참조하는 id 와 실재하는 id 를 집합으로 대조한다. app.js 가 스스로 만드는
     id(id: '...')도 실재하는 것으로 계산한다. */
  check("app.js 가 붙잡는 id 가 지면에 실재한다", () => {
    const want = [...app.matchAll(/\$\(\s*'#([\w-]+)'\s*\)/g)].map((m) => m[1]);
    if (want.length < 5) cannotMeasure(`붙잡는 id 를 ${want.length} 개만 셌다 — 세는 방식이 깨졌다`);
    const inHtml = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
    const made = new Set([...app.matchAll(/\bid:\s*'([\w-]+)'/g)].map((m) => m[1]));
    const lost = [...new Set(want)].filter((id) => !inHtml.has(id) && !made.has(id));
    if (lost.length) throw new Error(`지면에도 없고 만들지도 않는 id: ${lost.join(", ")}`);
    return true;
  });
}
