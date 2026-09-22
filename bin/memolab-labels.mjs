/* 화면 문구 검사. 라벨은 실제로 쓰는 말로 적는다.

   세 가지를 잡는다.

   (1) 서술형 종결. "~한다·~된다·~간다"는 설명문이지 라벨이 아니다.
   (2) 지어낸 명사형. 동사를 ~함/~음/~김으로 굴려 만든 말은 라벨처럼 보이지만
       아무도 쓰지 않는 말이다. 예를 들어 "다 함"이 아니라 "완료"로 적는다.
   (3) 12살이 막히는 말. 라벨은 짧게 만드는 것이 목적이 아니라 읽는 사람이 이미 아는 말을
       쓰는 것이 목적이다. 단어 정본은 시스템 쪽 plain-words.json 하나를 같이 읽는다.

   (2)를 통째로 막을 수는 없다. "없음"·"숨김"은 실제로 쓰는 말이기 때문이다.
   그래서 실제로 쓰는 말만 OK에 적어 두고, 새로 나타나는 것은 전부 걸러낸다.
   통과시키려면 OK에 손으로 적어야 하고, 적는 그 순간이 "이 말을 남들도 쓰는가"를
   다시 확인하는 시점이다.

   사용: node board/check-labels.mjs
*/

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// 검사 대상은 메모랩 화면이다. 검사기가 bin 에 있으므로 같은 폴더가 아니라 그쪽을 본다
const here = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'memolab');
const FILES = ['app.js', 'store.js', 'index.html'];

// 실제로 쓰는 명사형. 여기 없는 ~함/~음/~김은 지어낸 말로 본다.
const OK = new Set([
  // 실제로 쓰는 상태말
  '없음', '있음', '않음', '같음', '숨김', '미정', '처음', '모름', '다름',
  // 막힘: 「교통 막힘」·「하수구 막힘」처럼 실제로 쓰는 말. 할 일 이음의 선을 뜻한다
  '막힘',
  // 이 앱의 이름들. 동작이 아니라 명칭이다
  '묶음', '물음', '보관함', '이름', '다음', '처음', '이음',
  // 폐기된 이름. 화면에는 나오지 않고 옛 문서를 새 이름으로 옮기는 곳에만 남는다(store.js)
  '흘림함',
]);

/* 라벨 자리에 오면 안 되는 서술형 종결.

   단어를 나열하는 방식은 쓸 수 없다. `ㄴ다` 는 낱글자라서 `보인다` 의 `인다` 처럼 합쳐진
 글자를 찾지 못한다(확인 결과: 되돌린 `안 보인다` 가 그대로 통과했다).
   한국어 서술형 종결은 사실상 전부 `다` 로 끝나므로 그것을 본다.
   `다` 로 끝나는 정상적인 이름은 아래에 적어 둔다. 지금은 없다. */
const TELL_OK = new Set([]);
const tells = (p) => {
  const w = p.replace(/[.!?)\]」』"']+$/, '');
  return /다$/.test(w) && !TELL_OK.has(w.split(/\s+/).pop());
};

/* 지어낸 명사형 후보. 마지막 단어를 통째로 집는다.
 앞 글자에 붙은 것만 보면 "다 함"처럼 떨어져 있는 것을 놓친다(확인 결과).*/
const LAST = /(?:^|\s)([가-힣]+)[.!?)]?$/;
const NOMINAL = /(함|음|김|됨|뜸|남|임|짐|힘)$/;

/* 12살이 막히는 말. 목록도 찾는 방법도 이 저장소 밖의 하나가 정본이다. 여기에 따로 적으면
   두 규칙이 갈라진다. 그 파일이 없는 컴퓨터에서는 이 검사만 건너뛰고, 건너뛴 사실을 결과에
   적는다. 알리지 않고 빠지면 (1)(2)만 통과한 것을 셋 다 통과한 것으로 읽게 된다. */
const HARD_WORDS = join(homedir(), '.claude/.claude-system/skills/report-profile/assets/plain-words.mjs');
let findHard = () => [];
let hardSkipped = false;
try {
  const mod = await import(pathToFileURL(HARD_WORDS).href);
  findHard = mod.findHard;
} catch (error) {
  if (error && error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  hardSkipped = true;
}

const bad = [];

for (const f of FILES) {
  const src = readFileSync(join(here, f), 'utf8');
  /* 여러 줄 주석은 안쪽 줄이 별표로 시작하지 않을 수 있다. 첫 줄만 보고 넘기면
 둘째 줄부터 본문으로 읽혀 오탐이 난다(확인 결과: 주석 안 인용문 3건이 걸렸다).*/
  let inBlock = false;
  /* 낱말 말뭉치는 화면 문구가 아니다.

     낱말 보기는 토씨·어미 목록과 흔한 말 목록을 데이터로 들고 있다. 거기 있는 `있다`·`보다`는
     사람에게 보여 주는 말이 아니라 떼어낼 꼬리이므로, 라벨체로 고칠 대상이 아니다.
     그렇다고 검사에서 통째로 빼면 그 안에 진짜 화면 문구를 숨길 자리가 생긴다. 그래서
     여는 줄에 표시를 달게 하고 그 배열이 닫힐 때까지만 건너뛴다. 표시가 소스에 보이고,
     배열 하나를 벗어나지 않는다. */
  const MARK = '낱말 데이터';
  let inData = false;
  src.split('\n').forEach((ln, i) => {
    const st = ln.trim();
    if (inData) { if (/^\]\)?;?$/.test(st)) inData = false; return; }
    if (ln.includes(MARK) && /[[(]\s*$/.test(ln.replace(/\/[/*].*$/, '').trimEnd())) {
      inData = true;
      return;
    }
    const opens = ln.lastIndexOf('/*');
    const closes = ln.lastIndexOf('*/');
    const wasInBlock = inBlock;
    if (opens >= 0 && opens > closes) inBlock = true;
    else if (closes >= 0 && closes > opens) inBlock = false;
    if (wasInBlock || inBlock) return;
    if (st.startsWith('//')) return;
    for (const m of ln.matchAll(/(?:['"`>])([^'"`<>]*[가-힣][^'"`<>]*)(?:['"`<])/g)) {
      const s = m[1].trim();
      if (!s) continue;
      for (const part of s.split(/[.!?]\s+/)) {
        const p = part.trim();
        if (!p) continue;
        if (tells(p)) { bad.push([f, i + 1, s, '서술형 종결 — 라벨이 아니다']); break; }
        const hard = findHard(p);
        if (hard.length) {
          bad.push([f, i + 1, s,
            `${hard.map(([w, e]) => `"${w}"→"${e}"`).join(' ')} — 12살이 막히는 말`]);
          break;
        }
        const n = p.match(LAST);
        if (n && NOMINAL.test(n[1]) && !OK.has(n[1])) {
          bad.push([f, i + 1, s, `"${n[1]}" — 지어낸 명사형. 쓰는 말로 바꾸거나 OK에 등록`]);
          break;
        }
      }
    }
  });
}

const hardNote = hardSkipped ? ` (12살 낱말 검사는 건너뜀 — ${HARD_WORDS} 없음)` : '';
if (!bad.length) {
  console.log(`화면 문구 통과 — 서술형 0, 지어낸 명사형 0${hardNote}`);
  process.exit(0);
}
for (const [f, ln, s, why] of bad) console.error(`${f}:${ln}  ${s}\n    → ${why}`);
console.error(`\n${bad.length}건.`);
process.exit(1);
