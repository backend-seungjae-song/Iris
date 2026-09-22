/* 판. 조각은 한 번만 만들고 프레임은 갈아 끼운다.

   배치를 사람이 정하지 않는다. 사람이 정하는 것은 "어느 칸이냐" 하나뿐이고
   그 안의 위치는 칸이 계산한다. 자유 캔버스가 매번 요구하는 좌표 결정이
   여기서는 필요 없다. */

import { Store } from './store.js';
import { TERMS, tip } from './terms.js';
import { mergeFolder, railGroups } from './group.js';
import { wordCfg, wordMap } from './words.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

/* 판에 붙는 것은 둘이다.

   상황(kind): 이 판이 무엇을 하는 곳인가. 칸의 이름을 정한다.
   보기(view): 같은 조각을 어떤 기준으로 보는가.

   층위가 다른 것을 같은 줄에 늘어놓으면 고를 때마다 무엇을 고르는지 알기 어렵다.
   그래서 상황과 보기를 나눈다. */

const KINDS = {
  group: { name: '묶음', line: '덩어리로 모아 이름 붙이기.' },
  quad: { name: '나눔', line: '두 축으로 가르기. 무엇부터 할지.' },
  todo: { name: '할 일', line: '걸리는 시간을 적으면 오늘 순서가 시각으로.' },
  meet: { name: '회의', line: '정한 것·할 것·안 정한 것 + 들은 것·의문.' },
  study: { name: '공부', line: '그대로 옮기고, 덮은 채 내 말로 다시 쓰기.' },
  prep: { name: '준비', line: '회의 전. 목적 하나 고르고 꺼낼 것 가르기.' },
};

const VIEWS = {
  box: {
    name: '기본', line: '목적에 맞는 칸에 넣기.',
    what: '같은 무리끼리 모으기',
    eg: '회의에서 나온 말을 「정한 것·할 것·안 정한 것」에 나눠 넣기',
    art: '<rect x="1" y="1" width="12" height="9"/><rect x="15" y="1" width="12" height="9"/>'
       + '<rect x="1" y="12" width="12" height="9"/><rect x="15" y="12" width="12" height="9"/>',
  },
  line: {
    name: '흐름', line: '단계로 늘어놓기. 줄을 늘리면 나란히.',
    what: '순서대로 늘어놓기',
    eg: '「신청 → 심사 → 발송」. 줄을 늘리면 「우리 쪽·고객 쪽」이 나란히',
    art: '<rect x="1" y="7" width="7" height="8"/><rect x="11" y="7" width="7" height="8"/>'
       + '<rect x="21" y="7" width="7" height="8"/>'
       + '<path d="M8 11h3M18 11h3" class="ar"/>',
  },
  tree: {
    name: '갈래', line: '위아래로 쪼개기.',
    what: '큰 것을 작게 쪼개기',
    eg: '「매출 안 늘어남」 아래에 「사람이 안 옴·와도 안 삼」, 그 아래 또 쪼개기',
    art: '<rect x="9" y="1" width="10" height="7"/>'
       + '<rect x="1" y="14" width="10" height="7"/><rect x="17" y="14" width="10" height="7"/>'
       + '<path d="M14 8v3M6 11h16M6 11v3M22 11v3" class="ar"/>',
  },
  word: {
    name: '마인드맵', line: '같은 말이 든 것끼리 한 가지로 뻗어 나가는 지도.',
    what: '같은 말이 든 것끼리',
    eg: '가운데에 판, 둘레에 「벌점」 가지, 그 끝에 조각 셋',
    art: '<rect x="1" y="8" width="9" height="7"/>'
       + '<rect x="18" y="1" width="9" height="6"/><rect x="18" y="9" width="9" height="6"/>'
       + '<rect x="18" y="17" width="9" height="6"/>'
       + '<path d="M10 11h4M14 4v15M14 4h4M14 11h4M14 19h4" class="ar"/>',
  },
  link: {
    name: '이음', line: '끌어다 이으면 그림이 저절로. 자리 잡기 없음.',
    what: '무엇 때문에 무엇인지',
    eg: '「광고비 1달에 1억」 →때문에→ 「구독제는 무리」',
    art: '<rect x="1" y="2" width="9" height="7"/><rect x="18" y="13" width="9" height="7"/>'
       + '<rect x="1" y="13" width="9" height="7"/>'
       + '<path d="M10 6h4v10h4M10 16h8" class="ar"/>',
  },
};

/* 보기는 넷이지만 그 안에서 무엇을 묻는지는 상황마다 다르다.

   이것이 없으면 회의판의 줄과 공부판의 줄이 완전히 같고, 할 일의 이음이 회의의 이음과
   같은 문구를 쓴다. 할 일에서 두 조각을 잇는 것은 "때문에"가 아니라 "먼저"이므로,
   같은 그림이라도 묻는 것이 다르다.

   담는 칸은 셋으로 고정하고 이름만 상황이 정한다. 칸을 늘리면 선택지가 많아져
   고르기 어려워진다. */

const TUNE = {
  group: {
    link: { cause: '때문에', block: '방해', same: '같음' },
    linkAsk: '무엇 때문에 무엇인가',
    line: ['1', '2', '3'], lane: '',
    here: '지금 여기', herePh: '주제 · 장',
    treeTop: '맨 위', treeAsk: '큰 것을 작은 것으로',
  },
  quad: {
    link: { cause: '때문에', block: '맞바꿈', same: '같음' },
    linkAsk: '하나를 고르면 무엇을 잃는가',
    line: ['먼저', '다음', '나중'], lane: '',
    here: '지금 여기', herePh: '기준 · 묶음',
    treeTop: '고를 것', treeAsk: '고르는 기준을 쪼개기',
  },
  todo: {
    link: { cause: '먼저', block: '막힘', same: '같이' },
    linkAsk: '무엇이 끝나야 무엇을 하는가',
    line: ['오늘', '이번 주', '나중'], lane: '회사',
    here: '지금 하는 일', herePh: '프로젝트 이름',
    treeTop: '큰 일', treeAsk: '한 번에 할 수 있을 때까지 쪼개기',
  },
  meet: {
    link: { cause: '때문에', block: '방해', same: '같음' },
    linkAsk: '왜 그렇게 정했는가',
    line: ['안건 1', '안건 2', '안건 3'], lane: '우리 쪽',
    here: '지금 안건', herePh: '안건 1 · 예산',
    treeTop: '오늘 안건', treeAsk: '안건을 논점으로 쪼개기',
  },
  study: {
    link: { cause: '때문에', block: '반대', same: '같음' },
    linkAsk: '이 개념이 저 개념과 어떻게 얽히는가',
    line: ['처음', '중간', '끝'], lane: '',
    here: '지금 위치', herePh: '12:30 · p.42',
    treeTop: '오늘 배운 큰 것', treeAsk: '큰 개념을 작은 개념으로',
  },
  prep: {
    link: { cause: '근거', block: '반론', same: '같음' },
    linkAsk: '이 주장을 무엇이 받치는가',
    line: ['열기', '본론', '닫기'], lane: '',
    here: '지금 여기', herePh: '순서 · 주제',
    treeTop: '이 회의로 얻을 것', treeAsk: '얻을 것을 꺼낼 말로 쪼개기',
  },
};

const tune = (b) => TUNE[b.kind] || TUNE.group;

/* 의문은 판 밖으로 내보내지 않는다.

   ⌘/ 가 보관함으로 포커스를 옮겨 담는 것은 다른 생각이 떠올라 잠깐 옮겨 두는 동작이지
   의문의 동작이 아니다. 지금 보고 있는 판에서 생긴 의문은 그 판에 남아야 나중에 그 판을
   다시 열 때 함께 보인다.

   그래서 탭마다 의문 칸을 하나씩 둔다. 공부·준비는 이미 칸으로 갖고 있고,
   회의는 접힌 줄로 갖고 있다. 나머지 셋(묶음·나눔·할 일)에는 같은 접힌 줄을 붙인다.
   칸 이름은 어느 탭에서나 'ask' 하나여야 단축키가 탭마다 갈리지 않는다. */

// 의문이 이미 칸으로 있는 탭. 여기에는 줄을 더 붙이지 않는다
const ASK_IN_GRID = new Set(['study', 'prep']);
// 의문을 접힌 줄로 두는 탭
const ASK_AS_LINE = new Set(['meet', 'group', 'quad', 'todo']);
const linkName = (b, k) => tune(b).link[k] || k;

// place 키. 이전 판과 같은 문자열이라 그대로 열린다. 표는 store 한 곳에만 둔다
const FRAME_OF = Store.FRAME_OF;
const frameOf = (b) => (b.view === 'box' ? b.kind : FRAME_OF[b.view]);

/* 준비. 회의 전에 채우는 네 칸.

   목적을 넷 중 하나로 고르게 하는 것이 이 프레임의 제약이다. 목적이 정해지지 않은 회의는
   목적이 없는 것이 아니라 명확하지 않은 것이고, 그만큼 시간이 더 든다.
   목적을 고르면 네 칸이 각각 무엇을 묻는지가 바뀐다. 칸은 그대로이고 질문만 달라진다.

   넷째 칸(안 꺼낼 것)은 지금 다루지 않을 것을 옮겨 두는 칸이다. 떠오른 것을 지우지 않고
   오늘 범위 밖으로 옮긴다. 소요 시간을 적어 두면 이 칸이 실제로 쓰인다. */

const PREP_GOALS = [
  ['share', '정보 공유'],
  ['decide', '의사 결정'],
  ['solve', '문제 해결'],
  ['idea', '아이디어'],
];

const PREP_SLOTS = ['result', 'say', 'ask', 'park'];

// [칸 이름, 그 칸이 묻는 것]. 목적별로 달라진다
const PREP_ASK = {
  none: {
    result: ['끝나면 정해져 있을 것', '없으면 회의가 끝나지 않음'],
    say: ['꺼낼 것', '위에서부터 말할 순서'],
    ask: ['물어볼 것', '남에게 확인·요청할 것'],
    park: ['오늘은 안 꺼낼 것', '떠올랐지만 오늘 자리가 아닌 것'],
  },
  share: {
    result: ['다들 무엇을 알고 나가야 하는가', '한 문장으로'],
    say: ['설명할 것', '위에서부터 말할 순서'],
    ask: ['미리 읽어 오라 할 것', '읽고 올 거라 믿지 않기 — 자리에서 다시 요약'],
    park: ['오늘은 안 꺼낼 것', '설명이 길어지는 지점 미리 제외'],
  },
  decide: {
    result: ['무엇이 결정되어 있어야 하는가', '이 결정으로 무엇을 바꾸려는 것인지까지'],
    say: ['선택지와 내 안', '고를 것 미리 늘어놓기'],
    ask: ['결정권자·판단 기준', '기준이 없으면 결정 불가'],
    park: ['오늘은 안 꺼낼 것', '이 결정에 안 걸리는 것'],
  },
  solve: {
    result: ['어디까지 좁혀져 있어야 하는가', '다 풀 필요 없음'],
    say: ['갈등 포인트', '어디서 갈리는지 집어야 토론 가능'],
    ask: ['사실 확인할 것', '추측으로 다투게 되는 지점'],
    park: ['오늘은 안 꺼낼 것', '원인은 맞지만 오늘 못 다루는 것'],
  },
  idea: {
    result: ['몇 개를 건져 나갈 것인가', '개수를 정해 두면 끝이 분명'],
    say: ['미리 조사해 온 것', '빈손으로 가면 들러리'],
    ask: ['제약·예산·기한', '모르면 아무 안이나'],
    park: ['오늘은 안 꺼낼 것', '재밌지만 이 주제가 아닌 것'],
  },
};

/* 할 일. 한 화면이 세 가지를 동시에 답한다.

   (1) 전체 할 일은?      → 아래 네 칸. 아무것도 숨기지 않는다.
   (2) 오늘 언제 뭘?      → 위 오늘 띠. 놓는 칸이 아니라 날짜·시각에서 저절로 서는 띠다.
   (3) 그래서 지금 뭘?    → 맨 위 한 줄. 별을 찍었으면 그것, 아니면 오늘 띠의 첫 미완료.

   대분류(회사·개인)와 날짜·시각은 칸이 아니라 조각에 붙는다. 그래야 프레임을 갈아 끼워도 남고,
   같은 조각이 여러 칸을 오가도 일정이 따라다닌다. */

const TODO_SLOTS = [
  ['now', '할 일'],
  ['wait', '기다리는 중'],
  ['some', '언젠가'],
  ['done', '끝'],
];

const TODO_CATS = [{ k: 'c0', n: '회사' }, { k: 'c1', n: '개인' }];

function todoCats(b) {
  const c = b.cfg.todo || {};
  return c.cats && c.cats.length ? c.cats : TODO_CATS;
}

const pad2 = (n) => String(n).padStart(2, '0');
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nowHM() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const catName = (b, k) => (todoCats(b).find((c) => c.k === k) || {}).n || '';

const toMin = (hm) => (Number(hm.slice(0, 2)) * 60) + Number(hm.slice(3, 5));
function fromMin(m) {
  const day = Math.floor(m / 1440);
  const r = ((m % 1440) + 1440) % 1440;
  return (day > 0 ? '내일 ' : '') + `${pad2(Math.floor(r / 60))}:${pad2(r % 60)}`;
}
function humanMin(m) {
  if (!m) return '';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return (h ? `${h}시간` : '') + (h && r ? ' ' : '') + (r ? `${r}분` : '');
}

/* 순서는 사람이 정한다. 없으면 만든 순서를 따른다.
   시각을 직접 적지 않는다. 순서대로 쌓으면 시작 시각이 계산된다.

   순서는 분류마다 따로 센다. 판 하나에 붙이면 할 일에서 매긴 순서가
 묶음·공부의 같은 카드 순서까지 바꾼다.*/
function byPlan(b, frame) {
  const ord = (p) => Store.orderOf(b, frame, p.id);
  return (a, c) => {
    const d = (p) => p.due || '9999-99-99';
    if (d(a) !== d(c)) return d(a) < d(c) ? -1 : 1;
    if (ord(a) !== ord(c)) return ord(a) - ord(c);
    return a.at < c.at ? -1 : a.at > c.at ? 1 : 0;
  };
}

/* 공부. 보면서 쌓고, 덮고 나서 다시 쓴다.

   칸 넷은 순서를 권하는 단서이지 통과해야 하는 조건이 아니다. 네 칸을 다 채웠는지로
   학습이 끝났는지를 판정하지 않는다. 자기설명이 이해를 돕는다는 근거는 있지만 칸에
 배치하는 행위 자체가 검증된 것은 아니다.
   "그대로"를 덮는 단추를 둔다. 원문을 가린 채 내 말 칸만 보고 말이 되는지 확인한다.

   위치(12:30·p.42)는 조각에 붙는다. 영상은 되감아야 하고 그 시점은 나중에 복원되지 않는다.
   그래서 더미 위에 "지금 위치" 칸을 두고, 거기 적힌 값이 새로 담는 조각에 찍힌다. */

const STUDY_SLOTS = [
  ['quote', '그대로', '원문에서 그대로 집은 것. 판단 없이'],
  ['mine', '내 말로', '같은 것을 내 문장으로. 이유·원리까지 붙이면 더'],
  ['ask', '의문', '모르는 것·확인할 것·안 맞아 보이는 것'],
  ['use', '그래서 나는', '내가 바꿀 것 하나. 지금 없을 수도'],
];

/* 회의. 칸은 셋 그대로 두고, 빠져 있던 항목을 카드 안에 넣는다.

   담당자와 기한이 없는 할 일은 회의록에 적혀 있어도 실행되지 않고, 결정은 "왜"가
   함께 없으면 다음 회의에서 다시 논의된다.
   그래서 칸을 늘리지 않고 카드에 입력 칸을 붙였다.

   - 정한 것 → 왜
   - 할 것·안 정한 것 → 담당자, 기한

   담당자는 참석자에서 고른다. 참석자를 적는 것이 담당자를 고르게 만드는 앞단계다. */

const meetWho = (b) => ((b.cfg.meet || {}).who || '')
  .split(/[,·\n]/).map((x) => x.trim()).filter(Boolean);

/* 칸이 셋이면 단순 정보가 들어갈 칸이 없어 전부 "정한 것"으로 모인다. 확인 결과:
   정한 것 11건 중 실제 결정은 둘셋이고 나머지는 수치·이름·구조 설명·상대 의견이었다.
   칸이 잘못되면 담당자·기한을 붙여도 그대로이므로, 받아 적는 칸을 먼저 만든다.

   들은 것은 판단하지 않고 담는 칸이다. 회의 중에는 분류하기 어려워 대부분 여기로
   들어오고, 끝난 뒤에 셋으로 옮긴다. 남은 것은 그대로 맥락이 된다. */
/* 읽는 순서가 중요도를 나타낸다. 회의록을 여는 사람이 알고 싶은 것은 정한 것·할 것·
   남은 것 셋이고, 들은 것은 그 셋을 만든 재료다. 넷을 나란히 놓으면 무엇이 결과인지
   구분되지 않는다. 그래서 셋만 본문에 두고 들은 것은 아래에 접어 둔다.
   접힌 줄에도 그대로 놓을 수 있다.

   더미와는 다르다. 더미는 아직 보지 않은 것이고, 들은 것은 확인한 뒤 셋 중 어디에도
   해당하지 않아 맥락으로 남긴 것이다. 그래서 더미처럼 미배치로 표시하지 않는다. */
const MEET_SLOTS = [
  ['decided', '정한 것'],
  ['todo', '할 것'],
  ['open', '안 정한 것'],
  ['heard', '들은 것'],
  ['ask', '의문'],
];
const MEET_MAIN = MEET_SLOTS.slice(0, 3);
/* 본문 아래 접히는 두 줄. 칸을 다섯으로 늘리면 결정·할 일·미결이 잘 보이지 않는다.
   의문은 안 정한 것과 다르다. 안 정한 것은 정해야 하는데 못 정한 안건이고,
   의문은 안건이 아닐 수도 있다. 회의 중에 다루면 논의가 길어진다. */
const MEET_MORE = [
  ['heard', '들은 것', '판단하지 않고 담아 두는 자리'],
  ['ask', '의문', '지금은 답을 찾지 않는 자리. 회의 끝나고 의문 목록에서'],
];

const meetOpen = { heard: false, ask: false };

let picked = null;

/* 지금 어디를 보고 있는가.

   원래 공부 프레임에만 있던 값으로, 영상 12:30 에서 담은 조각에 그 시각을 기록한다.
   다시 찾을 위치가 필요한 것은 영상만이 아니다. 회의의 안건 번호, 할 일의 프로젝트,
   공부의 재생 시각이 모두 같은 값이다. 한 번 적어 두면 그 뒤에 담는 조각에 자동으로
   붙고, 나중에 그 위치만 골라 볼 수 있다.

   hereAt 은 지금 걸러 보고 있는 위치다. null 이면 전부이고, 판을 바꾸면 해제된다. */
let hereAt = null;

// 이 판이 위치를 쓰고 있는가. 쓰지 않는 판에는 위치 관련 단추를 띄우지 않는다
const usesHere = (b) => !!(b.at || b.pieces.some((p) => (p.loc || '').trim()));

// 이 판에 실제로 있는 위치. 사람이 읽는 순서로 정렬한다
function hereList(b) {
  const seen = new Map();
  b.pieces.forEach((p) => {
    const k = (p.loc || '').trim();
    if (k) seen.set(k, (seen.get(k) || 0) + 1);
  });
  if (b.at && !seen.has(b.at)) seen.set(b.at, 0);
  return [...seen.entries()].map(([loc, n]) => ({ loc, n }))
    .sort((x, y) => locRank(x.loc) - locRank(y.loc));
}

// 나무·이음은 칸을 안 쓰므로 거를 수가 없다. 거기서는 거르개를 감춘다
const CAN_FILTER = (b) => b.frame !== 'tree' && b.frame !== 'link';
let dragging = null;   // 지금 끌고 있는 조각 id

/* ---------- 끌어다 놓기 ----------

   누르고-칸-누르기는 그대로 둔다. 터치로 쓰는 환경과 칸이 화면 밖에 있는 경우에는
   그 방법만 쓸 수 있기 때문이다. 드래그는 그 위에 더하는 두 번째 방법이다.

   끄는 동안에는 다시 그리지 않는다. 원본 노드가 사라지면 브라우저가 드래그를 중단한다.
   그래서 칸을 강조하는 것은 body 클래스로만 한다. */

/* 끌고 가장자리에 대면 자동으로 스크롤된다.

   이것이 없으면 화면에 보이는 칸에만 놓을 수 있다. 끄는 동안에는 스크롤할 방법이 없어
   화면 밖의 칸은 사용할 수 없기 때문이다.
   그래서 포인터가 어느 칸의 가장자리에 있는 동안 그 칸을 스크롤한다. 대상은 포인터
   아래에서 위로 올라가며 찾은 첫 스크롤 칸이라, 칸 안이면 칸이 스크롤되고
   칸 밖이면 판 전체가 스크롤된다. */
const EDGE_BAND = 72;    // 가장자리로 치는 폭
const EDGE_STEP = 22;    // 한 번에 미는 양
let edgeAt = null;       // 지금 포인터 위치
let edgeTimer = null;

function edgeScrollables(x, y) {
  const out = [];
  let n = document.elementFromPoint(x, y);
  while (n && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    const canX = n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(cs.overflowX);
    const canY = n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(cs.overflowY);
    if (canX || canY) out.push({ n, canX, canY });
    n = n.parentElement;
  }
  return out;
}

function edgeTick() {
  if (!dragging || !edgeAt) return;
  const { x, y } = edgeAt;
  for (const { n, canX, canY } of edgeScrollables(x, y)) {
    const r = n.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (canX) {
      if (x < r.left + EDGE_BAND) dx = -EDGE_STEP;
      else if (x > r.right - EDGE_BAND) dx = EDGE_STEP;
    }
    if (canY) {
      if (y < r.top + EDGE_BAND) dy = -EDGE_STEP;
      else if (y > r.bottom - EDGE_BAND) dy = EDGE_STEP;
    }
    if (!dx && !dy) continue;
    const bx = n.scrollLeft;
    const by = n.scrollTop;
    n.scrollLeft += dx;
    n.scrollTop += dy;
    // 실제로 움직인 칸 하나에서 멈춘다. 끝까지 간 칸은 건너뛰고 그 바깥이 받는다
    if (n.scrollLeft !== bx || n.scrollTop !== by) return;
  }
}

function startEdgeScroll() {
  if (edgeTimer) return;
  edgeTimer = setInterval(edgeTick, 30);
}

function stopEdgeScroll() {
  clearInterval(edgeTimer);
  edgeTimer = null;
  edgeAt = null;
}

// 끄는 동안의 포인터 위치는 문서 전체에서 받는다. 놓을 수 없는 곳 위에서도 스크롤해야 한다
document.addEventListener('dragover', (e) => {
  if (!dragging) return;
  edgeAt = { x: e.clientX, y: e.clientY };
}, true);
document.addEventListener('drop', stopEdgeScroll, true);
document.addEventListener('dragend', stopEdgeScroll, true);

function dragSource(node, pieceId) {
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', (e) => {
    dragging = pieceId;
    document.body.classList.add('dragging');
    startEdgeScroll();
    try { e.dataTransfer.setData('text/plain', pieceId); } catch (err) { /* 일부 브라우저 */ }
    e.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => {
    dragging = null;
    document.body.classList.remove('dragging');
    stopEdgeScroll();
    document.querySelectorAll('.over').forEach((n) => n.classList.remove('over'));
  });
  return node;
}

function dropTarget(node, onDrop, canDrop) {
  const ok = () => !!dragging && (!canDrop || canDrop(dragging));
  node.addEventListener('dragenter', (e) => { if (ok()) { e.preventDefault(); e.stopPropagation(); } });
  node.addEventListener('dragover', (e) => {
    if (!ok()) return;
    e.preventDefault();
    e.stopPropagation();          // 겹친 칸에서는 안쪽이 받는다
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('over');
  });
  node.addEventListener('dragleave', (e) => {
    if (node.contains(e.relatedTarget)) return;   // 자식으로 옮겨간 것은 떠난 것이 아니다
    node.classList.remove('over');
  });
  node.addEventListener('drop', (e) => {
    if (!ok()) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragging;
    node.classList.remove('over');
    dragging = null;
    document.body.classList.remove('dragging');
    picked = null;
    onDrop(id);
  });
  return node;
}

/* ---------- 조각 카드 ---------- */

/* 카드 안의 입력칸을 누를 때는 드래그가 시작되면 안 된다. 부모가 draggable이면
   브라우저에 따라 자식 입력칸이 아예 안 잡히므로, 누르는 동안만 끄고 손을 떼면 되돌린다. */
function noDrag(node, card) {
  node.addEventListener('pointerdown', () => card.setAttribute('draggable', 'false'));
  return node;
}
document.addEventListener('pointerup', () => {
  document.querySelectorAll('.piece[draggable="false"], .placed[draggable="false"]')
    .forEach((n) => n.setAttribute('draggable', 'true'));
});

function metaRow(b, p, card) {
  const set = (patch) => { Store.setMeta(b.id, p.id, patch); render(); };
  const row = el('div', { class: 'meta' });

  const sel = el('select', { class: 'cat', title: '대분류' });
  sel.append(el('option', { value: '' }, '분류'));
  todoCats(b).forEach((c) => {
    const o = el('option', { value: c.k }, c.n || '이름 없음');
    if (p.cat === c.k) o.setAttribute('selected', 'selected');
    sel.append(o);
  });
  sel.addEventListener('change', () => set({ cat: sel.value }));
  row.append(noDrag(sel, card));

  const d = el('input', { class: 'due', type: 'date', value: p.due || '', title: '언제' });
  d.addEventListener('change', () => set({ due: d.value }));
  if (p.due && p.due < today() && !(Store.slots(b, 'todo')[p.id] === 'done')) d.classList.add('late');
  row.append(noDrag(d, card));

  // 몇 시가 아니라 얼마나 걸리는가. 시작 시각은 순서에서 나온다
  const m = el('input', {
    class: 'mins', type: 'number', min: '5', step: '5', value: p.mins || '',
    placeholder: '분', title: '걸리는 시간 (분)',
  });
  m.addEventListener('change', () => set({ mins: Number(m.value) || 0 }));
  row.append(noDrag(m, card), el('span', { class: 'unit' }, '분'));

  if (p.due) {
    row.append(noDrag(el('button', {
      class: 'mini', title: '날짜 지우기', onclick: () => set({ due: '' }),
    }, '×'), card));
  } else {
    row.append(noDrag(el('button', {
      class: 'mini', title: '오늘로', onclick: () => set({ due: today() }),
    }, '오늘'), card));
  }
  return row;
}

const whyOpen = new Set();   // 지금 '왜'를 적고 있는 조각

function meetRow(b, p, card) {
  const slot = Store.slots(b, 'meet')[p.id];
  if (!slot) return null;                       // 아직 칸에 안 들어간 것은 물을 것이 없다
  const set = (patch) => { Store.setMeta(b.id, p.id, patch); render(); };
  const row = el('div', { class: 'meta' });

  const who = meetWho(b);
  const pick = (field, label, cur) => {
    const sel = el('select', { class: 'cat', title: label });
    sel.append(el('option', { value: '' }, label));
    who.forEach((n) => {
      const o = el('option', { value: n }, n);
      if (cur === n) o.setAttribute('selected', 'selected');
      sel.append(o);
    });
    if (cur && !who.includes(cur)) {
      const o = el('option', { value: cur }, cur);
      o.setAttribute('selected', 'selected');
      sel.append(o);
    }
    sel.addEventListener('change', () => set({ [field]: sel.value }));
    return noDrag(sel, card);
  };

  // 들은 것은 발언자에 따라 중요도가 달라진다. 없으면 접어 둔다
  if (slot === 'heard') {
    if (!p.said && !whyOpen.has(p.id)) {
      row.append(noDrag(el('button', {
        class: 'mini', title: '누가 한 말인가',
        onclick: () => { whyOpen.add(p.id); render(); },
      }, '＋ 누가'), card));
      return row;
    }
    row.append(pick('said', '말한 사람', p.said));
    return row;
  }

  if (slot === 'decided') {
    // 빈 칸을 열한 개 늘어놓으면 화면이 복잡해진다. 적을 때만 열린다
    if (!p.why && !whyOpen.has(p.id)) {
      row.append(noDrag(el('button', {
        class: 'mini', title: '왜 이렇게 정했는지 한 줄',
        onclick: () => { whyOpen.add(p.id); render(); },
      }, '＋ 왜'), card));
      return row;
    }
    const w = el('input', {
      class: 'why', type: 'text', value: p.why || '', placeholder: '왜 이렇게 정했나',
    });
    w.addEventListener('change', () => { whyOpen.delete(p.id); set({ why: w.value.trim() }); });
    w.addEventListener('blur', () => { if (!w.value.trim()) { whyOpen.delete(p.id); render(); } });
    row.append(noDrag(w, card));
    setTimeout(() => { if (whyOpen.has(p.id)) w.focus(); }, 0);
    return row;
  }

  row.append(pick('owner', '담당자', p.owner));

  const d = el('input', { class: 'due', type: 'date', value: p.due || '', title: '기한' });
  d.addEventListener('change', () => set({ due: d.value }));
  row.append(noDrag(d, card));

  // 빈칸 표시를 카드마다 다시 붙이지 않는다. 고르지 않은 칸이 이미 비어 보이고,
  // 몇 개가 비었는지는 위 한 줄이 센다. 같은 정보를 두 번 표시하지 않는다.
  return row;
}

/* 조각에 붙은 값은 어느 탭에서 적었든 그 조각의 값이다.

   pieceNode 가 b.frame 으로 갈라서 줄을 붙이면 적은 탭에서만 값이 보인다. 그러면 같은
   조각을 흐름·갈래·이음으로 옮겼을 때 카드가 한 줄로 돌아가고, 회의에서 정한 담당이
   흐름에서 보이지 않는다. 조각을 한 번만 만든다는 이 판의 전제와 어긋난다.

   값이 있으면 어디서나 보이고, 고치는 곳은 한 곳이다. 적는 칸은 그 값을 소유한 탭에만
   두고 다른 탭에서는 읽기 전용 딱지로 낸다. 소유한 탭에서 이미 보이는 값은 딱지로
   다시 내지 않는다. */

// 이 탭의 적는 줄이 이미 보여 주는 값. 여기 있는 것은 딱지로 안 낸다
function coveredBy(b, p, placed) {
  if (b.frame === 'todo') return new Set(['cat', 'due', 'mins']);
  /* 공부 칸은 위치별로 묶여 있다. 묶음 머리가 이미 표시한 값을 카드가 다시 표시하지 않는다.
     더미 카드는 묶여 있지 않으므로 딱지를 그대로 둔다. 여기서도 지우면 아직 없는 위치를
 새로 적을 방법이 사라진다(확인 결과: 조각 하나를 새 위치로 보낼 수 없었다).*/
  if (b.frame === 'study' && placed && usesHere(b)) return new Set(['loc']);
  if (b.frame === 'meet') {
    const slot = Store.slots(b, 'meet')[p.id];
    if (!slot) return new Set();
    if (slot === 'heard') return new Set(['said']);
    if (slot === 'decided') return new Set(['why']);
    return new Set(['owner', 'due']);
  }
  return new Set();
}

// 모양 보기 셋에는 의문 칸이 없다. 거기서만 의문 딱지가 그 칸을 대신한다
const SHAPE_FRAMES = new Set(['flow', 'tree', 'link']);

const dueShort = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const isLate = (b, p) => !!p.due && p.due < today()
  && Store.slots(b, b.frame)[p.id] !== 'done';

// 지금 위치를 고치고 있는 조각. 「＋ 왜」와 같은 방식으로 빈 칸을 늘어놓지 않는다
const locOpen = new Set();
// 지금 고치고 있는 조각. 한 번에 하나만 열린다
let editId = null;

/* 카드 안에서 바로 고치는 칸.

   카드가 draggable 이라 그대로 두면 글자를 선택하는 순간 끌기가 먼저 잡히므로, noDrag 로
   누르는 동안만 끌기를 끈다. 줄바꿈이 있는 조각이 많아 Enter 는 줄바꿈이고
   저장은 칸을 벗어날 때 한다. 취소는 Esc 하나다. */
function editBox(b, p) {
  const box = el('textarea', { class: 'tedit', rows: '1' });
  box.value = p.text;
  const grow = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight}px`; };
  let done = false;
  const shut = (keep) => {
    if (done) return;
    done = true;
    editId = null;
    const next = box.value.trim();
    if (keep && next && next !== p.text) Store.editPiece(b.id, p.id, next);
    render();
  };
  box.addEventListener('input', grow);
  box.addEventListener('blur', () => shut(true));
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { shut(false); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); shut(true); }
  });
  box.addEventListener('click', (e) => e.stopPropagation());
  /* 카드를 만드는 중에는 카드 자신을 인자로 받을 수 없다. 그 상수는 아직 초기화 전이라
 참조하면 오류가 난다(확인 결과: 공부 칸 넷이 화면에서 사라졌다).
     그래서 인자로 받지 않고 눌린 시점에 상위로 올라가며 찾는다. */
  box.addEventListener('pointerdown', () => {
    const card = box.closest('[draggable]');
    if (card) card.setAttribute('draggable', 'false');
  });
  setTimeout(() => {
    if (!box.isConnected) return;
    grow();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, 0);
  return box;
}
// 마인드맵에서 눌러 둔 가지. 그 가지에 안 걸린 것은 흐리게 둔다
let wordPick = null;
// 지금 고치고 있는 판 설정 칸. 딱지를 눌러야 입력칸이 나온다
const cfgOpen = new Set();
const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

function chipRow(b, p, card, placed) {
  const has = coveredBy(b, p, placed);
  const chip = (cls, t) => el('span', { class: 'chip' + (cls ? ' ' + cls : '') }, t);
  const out = [];
  if (!has.has('cat') && p.cat && catName(b, p.cat)) out.push(chip('', catName(b, p.cat)));
  if (!has.has('owner') && p.owner) out.push(chip('who', p.owner));
  if (!has.has('said') && p.said) out.push(chip('who', p.said));
  if (!has.has('due') && p.due) {
    // 기한이 지난 것은 「늦은 8/25」로 표시한다. 색만으로는 이유를 알 수 없다
    out.push(chip(isLate(b, p) ? 'late' : '', (isLate(b, p) ? '늦은 ' : '') + dueShort(p.due)));
  }
  if (!has.has('mins') && p.mins) out.push(chip('mins', humanMin(p.mins)));
  // 위치는 읽기 전용 딱지가 아니라 눌러서 그 자리에서 고친다.
  // 이 판이 위치를 쓰는 중이면 아직 값이 없는 카드에도 붙일 수단을 둔다
  if (!has.has('loc')) {
    if (locOpen.has(p.id)) {
      const inp = el('input', {
        class: 'locin', type: 'text', value: p.loc || '', placeholder: tune(b).herePh,
      });
      /* 벗어날 때의 처리를 한 곳으로 모은다. blur 가 입력값을 버리고 다시 그리면,
         그 다시 그리기가 change 보다 먼저 올 때 입력칸이 사라져 적은 값이 사라진다
 (확인 결과: 17 → 2 로 고친 값이 세 번 다 17 로 남았다).
         적었으면 저장하고, 취소는 Esc 로만 한다. */
      let done = false;
      const commit = (save) => {
        if (done) return;
        done = true;
        locOpen.delete(p.id);
        if (save) Store.setMeta(b.id, p.id, { loc: inp.value.trim() });
        render();
      };
      inp.addEventListener('change', () => commit(true));
      inp.addEventListener('blur', () => commit(true));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); commit(false); }
      });
      setTimeout(() => { if (inp.isConnected) inp.focus(); }, 0);
      out.push(card ? noDrag(inp, card) : inp);
    } else if (p.loc) {
      out.push(el('button', {
        class: 'chip at', title: tip('위치'),
        onclick: (e) => { e.stopPropagation(); locOpen.add(p.id); render(); },
      }, p.loc));
    } else if (usesHere(b)) {
      out.push(el('button', {
        class: 'chip add', title: tip('위치'),
        onclick: (e) => { e.stopPropagation(); locOpen.add(p.id); render(); },
      }, '＋ 위치'));
    }
  }
  if (!has.has('why') && p.why) out.push(chip('why', p.why));
  if (p.q && SHAPE_FRAMES.has(b.frame)) out.push(chip('ask', '의문'));
  return out.length ? el('div', { class: 'chips' }, out) : null;
}

/* 카드 왼쪽 띠 하나가 주목할 카드를 표시한다.

   색은 둘뿐이다. 셋이 넘으면 무엇이 급한지 구분되지 않아 띠의 효과가 없어진다.
   중요도는 사람에게 묻지 않고 이미 적어 둔 값에서 계산한다. */
function pieceFlag(b, p) {
  if (isLate(b, p)) return 'late';
  if (p.q) return 'ask';
  return '';
}

function pieceNode(b, p, placed, move, idx) {
  const isStar = b.star === p.id;
  const node = el('div', {
    class: (placed ? 'placed' : 'piece') + (picked === p.id ? ' picked' : '')
      + (found === p.id ? ' found' : '')
      + (isStar ? ' starred' : '') + (pieceFlag(b, p) ? ' f-' + pieceFlag(b, p) : ''),
    /* 누르면 고치고, 끌면 옮긴다.

       누르기를 집기로 쓰면 적어 둔 줄의 오타를 고칠 방법이 없어 지우고 다시 적어야 한다.
       옮기는 방법은 끌기로 이미 있으므로 누르기는 고치기에 배정한다. */
    onclick: (e) => {
      if (e.target.closest('button, select, input, textarea')) return;
      // 놓인 조각을 누르면 그 클릭이 칸까지 올라가 같은 칸에 도로 놓는다. 여기서 끊는다
      e.stopPropagation();
      if (editId !== p.id) { editId = p.id; render(); }
    },
  },
    el('div', { class: 'line' },
      el('button', {
        class: 'star', title: '지금 할 것 하나',
        onclick: () => { Store.star(b.id, p.id); render(); },
      }, isStar ? '★' : '☆'),
      editId === p.id ? editBox(b, p) : el('div', { class: 't' }, p.text),
      // 칸 안 순서. 평소에는 숨겼다가 카드에 포인터가 올라오면 표시한다.
      // 카드마다 단추 둘이 항상 붙어 있으면 화면이 복잡해진다
      move
        ? el('span', { class: 'ord' },
            el('button', { class: 'mini', title: '위로', onclick: () => move(idx, -1) }, '↑'),
            el('button', { class: 'mini', title: '아래로', onclick: () => move(idx, 1) }, '↓'))
        : null,
      /* 판 전체를 글로 복사하는 기능은 있지만 카드 한 장만 가져갈 방법이 없다.
         카드는 끌 수 있어서 글자를 마우스로 선택할 수도 없다. 끌기가 먼저 잡히기 때문이다.
         그래서 단추 하나로 제공한다. 여러 줄짜리는 줄바꿈까지 그대로 복사한다. */
      el('button', {
        class: 'copy', title: '이 조각을 글로 복사',
        onclick: (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(p.text);
          say('복사');
        },
      }, '⧉'),
      placed
        ? el('button', {
            class: 'back', title: '더미로 되돌리기',
            onclick: () => {
              Store.put(b.id, b.frame, p.id, null);
              picked = null;
              render();
            },
          }, '↩')
        : el('button', {
            class: 'x', title: '지우기',
            onclick: () => { Store.removePiece(b.id, p.id); picked = null; render(); },
          }, '×'),
    ),
  );
  if (b.frame === 'todo') node.append(metaRow(b, p, node));
  if (b.frame === 'meet') { const r = meetRow(b, p, node); if (r) node.append(r); }
  const chips = chipRow(b, p, node, placed);
  if (chips) node.append(chips);
  /* 지도에서는 밖으로 내보내지 않는다. 끌기를 「다른 탭의 칸으로 보내기」에 쓰면 지도 안에서
     위치를 옮길 방법이 사라지기 때문이다. 지도 안의 이동은 HTML5 끌기가 아니라 포인터로
     직접 처리하며, viewWord 의 mapDrag 가 그 처리를 담당한다. */
  if (b.frame === 'word') return node;
  return dragSource(node, p.id);
}

/* 칸 안의 순서는 사람이 정한다. 아직 안 정한 것은 만든 순서를 따른다.
   기본을 0 이 아니라 없음으로 두어야 나중에 들어온 조각이 맨 위로 튀지 않는다. */
function byOrd(b, frame) {
  const ord = (p) => Store.orderOf(b, frame, p.id);
  return (a, c) => {
    if (ord(a) !== ord(c)) return ord(a) - ord(c);
    return a.at < c.at ? -1 : a.at > c.at ? 1 : 0;
  };
}

/* 접힌 위치 묶음. 판마다 위치마다 따로 기억한다.

   판 문서가 아니라 창 상태에 담는다. 접힘은 보는 사람의 화면 상태이지 판의 내용이 아니라,
   다른 창에서 접었다고 이 창까지 접히면 안 된다. */
const locShut = (b, loc) => !!(Store.ui('locShut') || {})[`${b.id}|${loc}`];
function locShutSet(b, loc, on) {
  const m = { ...(Store.ui('locShut') || {}) };
  const k = `${b.id}|${loc}`;
  if (on) m[k] = 1; else delete m[k];
  Store.ui('locShut', m);
  render();
}

function slotNode(b, key, caption, extra = {}) {
  const s = Store.slots(b, b.frame);
  let inside = b.pieces.filter((p) => s[p.id] === key);
  // 위치를 하나 골라 두면 그 위치의 것만 남는다. 여기 한 곳에서 걸러야 모든 화면에 적용된다
  if (hereAt) inside = inside.filter((p) => (p.loc || '').trim() === hereAt);
  if (extra.only) inside = inside.filter(extra.only);
  inside = inside.slice().sort(extra.sort ? extra.sort(b, b.frame) : byOrd(b, b.frame));

  // 위아래로 옮기면 그 칸 전체에 순서를 다시 매긴다. 한 장만 번호를 주면
  // 나머지가 아직 없음(Infinity)이라 옮긴 것만 맨 위로 튄다.
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= inside.length) return;
    const seq = inside.slice();
    const [x] = seq.splice(i, 1);
    seq.splice(j, 0, x);
    Store.setOrder(b.id, b.frame, seq.map((q) => q.id));
    render();
  };

  /* 칸 안에서 위치별로 한 겹 더 묶는다.

     공부처럼 위치(12:30 · p.42)가 촘촘한 판에서는 「그대로」 칸 하나에 스무 장이 쌓이고,
     그것이 어느 파트 것인지는 카드마다 붙은 작은 딱지로만 알 수 있다. 한 겹 더 묶으면
     파트 경계가 그대로 보인다.

     묶음 머리는 놓는 곳이기도 하다. 카드를 거기 떨어뜨리면 그 칸으로 들어가면서 위치도
     그 값이 되므로, 위치를 고치려고 딱지를 따로 누르지 않아도 된다. */
  const grouped = extra.byLoc && inside.length;
  const putHere = (id, loc) => {
    Store.put(b.id, b.frame, id, key);
    if (loc !== undefined) Store.setMeta(b.id, id, { loc });
    render();
  };

  let body;
  if (grouped) {
    const seen = new Map();
    inside.forEach((p) => {
      const k = (p.loc || '').trim();
      const arr = seen.get(k) || [];
      arr.push(p);
      seen.set(k, arr);
    });
    // 위치 없는 것은 맨 아래. 아직 어디 것인지 정하지 않아 위로 올리면 주의를 끈다
    const keys = [...seen.keys()].sort((x, y) => (x ? 0 : 1) - (y ? 0 : 1) || locRank(x) - locRank(y));
    body = keys.map((k) => {
      const rows = seen.get(k);
      const shut = locShut(b, k);
      const head = el('div', { class: 'ghead' + (picked ? ' hot' : '') },
        /* 지나간 위치는 접는다. 강의 하나에 위치가 열여덟이면 계속 스크롤해야
 지금 듣고 있는 위치가 나온다.
           접은 위치는 창 상태에 남아 판을 다시 열어도 접힌 상태다. */
        el('button', {
          class: 'twist', title: shut ? '펼치기' : '접기',
          onclick: (e) => { e.stopPropagation(); locShutSet(b, k, !shut); },
        }, shut ? '▸' : '▾'),
        el('span', { class: 'at' }, k || '위치 없음'),
        el('span', { class: 'n' }, String(rows.length)),
        el('span', { class: 'drop' }, '여기에 놓기'));
      head.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target.closest('button')) return;
        if (!picked) return;
        const id = picked; picked = null; putHere(id, k);
      });
      dropTarget(head, (id) => putHere(id, k));
      return el('div', { class: 'grp' + (shut ? ' shut' : '') }, head,
        shut ? null
          : rows.map((p, i) => pieceNode(b, p, true, rows.length > 1 ? move : null, inside.indexOf(p))));
    });
  } else {
    body = inside.length
      ? inside.map((p, i) => pieceNode(b, p, true, inside.length > 1 ? move : null, i))
      : el('div', { class: 'empty' }, extra.hint || '');
  }

  const node = el('div', {
    class: 'slot' + (picked ? ' hot' : ''),
    'data-slot': key,
    onclick: (e) => {
      if (e.target.closest('button, input')) return;
      if (!picked) return;
      Store.put(b.id, b.frame, picked, key);
      picked = null;
      render();
    },
  },
    caption ? el('div', { class: 'cap', title: tip('칸') }, caption) : null,
    // 안쪽 목록을 감싼다. 가로 판에서 이 칸이 세로로 채우다 옆으로 접히는 영역이다
    el('div', { class: 'slotbody' }, body),
    /* 놓을 위치 표시. 끄는 중에는 다시 그릴 수 없으므로(원본 노드가 사라지면 브라우저가
       드래그를 중단한다) 항상 그려 두고 표시와 숨김은 CSS 가 한다.
       눌러서 골랐을 때는 .slot.hot, 끄는 중에는 body.dragging. */
    el('div', { class: 'droprow' }, '여기에 놓기'),
  );
  return dropTarget(node, (id) => {
    Store.put(b.id, b.frame, id, key);
    render();
  });
}

function editableCap(b, frame, field, value, ph) {
  const inp = el('input', { type: 'text', value: value || '', placeholder: ph || '' });
  inp.addEventListener('change', () => { Store.cfg(b.id, frame, { [field]: inp.value }); render(); });
  return inp;
}

/* ---------- 프레임별 화면 ---------- */

/* 아직 만들지 않은 판의 기본 항목. 화면과 트레이가 같은 값을 써야 한다.
 다르면 화면은 셋을 표시하는데 트레이는 하나만 표시한다.*/
const GROUPS0 = [{ k: 'g1', n: '' }, { k: 'g2', n: '' }, { k: 'g3', n: '' }];

function viewGroup(b, stage) {
  const cfg = b.cfg.group || {};
  const groups = cfg.groups || GROUPS0;
  const saveGroups = (g) => { Store.cfg(b.id, 'group', { groups: g }); render(); };

  // 이름부터 지으라고 하면 카드를 옮기지 않게 된다. 아직 이름이 없을 때만 한 줄로 안내한다
  if (!groups.some((g) => (g.n || '').trim())) {
    stage.append(el('p', { class: 'nudge' },
      '이름은 나중에. 먼저 옮기고, 모인 것을 보고 이름 붙이기.'));
  }

  stage.append(el('div', { class: 'groups board-h' },
    groups.map((g, i) => {
      const cap = el('div', { class: 'cap' });
      const inp = el('input', { type: 'text', value: g.n, placeholder: `덩어리 ${i + 1}` });
      inp.addEventListener('change', () => {
        const next = groups.map((x) => (x.k === g.k ? { ...x, n: inp.value } : x));
        saveGroups(next);
      });
      cap.append(inp);
      if (groups.length > 1) {
        cap.append(el('button', {
          class: 'x', title: '이 묶음 없애기',
          onclick: () => {
            const s = Store.slots(b, 'group');
            for (const [pid, sk] of Object.entries(s)) if (sk === g.k) Store.put(b.id, 'group', pid, null);
            saveGroups(groups.filter((x) => x.k !== g.k));
          },
        }, '×'));
      }
      const node = slotNode(b, g.k, null, { hint: '조각을 골라 여기에' });
      node.prepend(cap);
      return node;
    }),
    el('button', {
      class: 'addgroup',
      onclick: () => saveGroups([...groups, { k: 'g' + Date.now().toString(36), n: '' }]),
    }, '＋ 묶음'),
  ));
  askLine(b, stage);
}

/* 나눔의 축은 비어 있으면 아무 정보도 주지 않는다.

   빈 칸 넷과 이름 없는 축 넷만 있으면 무엇을 적어야 할지 알기 어렵고, 그래서 이 탭을
   쓰지 않게 된다. 가장 많이 쓰는 축을 기본값으로 둔다. 흐름의 단계 이름과 같은 방식이라
   저장은 건드리지 않고 기본값만 보여 주며, 고치면 그때 저장된다.

   칸 이름은 「어느 쪽인가」가 아니라 「그래서 무엇을 하나」로 적는다. 오른쪽 위가 급하고
   중요하다는 것은 위치가 이미 나타내므로, 그다음 정보를 담는다. */
const QUAD_DEF = { xl: '안 급한 것', xh: '급한 것', yl: '덜 중요한 것', yh: '중요한 것' };
const QUAD_DO = {
  hh: ['지금', '여기가 둘을 넘으면 아직 안 가른 것'],
  lh: ['날짜 잡기', '안 잡으면 영영 그대로'],
  hl: ['몰아서 한 번에', '하나씩 하는 순간 하루가 통째로'],
  ll: ['빼기', '지워도 되는지 한 번 보기'],
};

function viewQuad(b, stage) {
  const saved = b.cfg.quad || {};
  const c = { ...QUAD_DEF, ...saved };
  const cap = (k) => slotNode(b, k, QUAD_DO[k][0], { hint: QUAD_DO[k][1] });
  stage.append(el('div', { class: 'quad-wrap' },
    el('div', { class: 'quad-y' },
      el('div', {}, editableCap(b, 'quad', 'yh', c.yh, '위 칸 이름')),
      el('div', {}, editableCap(b, 'quad', 'yl', c.yl, '아래 칸 이름'))),
    el('div', { class: 'quad' },
      cap('lh'), cap('hh'),
      cap('ll'), cap('hl')),
    el('div', {}),
    el('div', { class: 'quad-x' },
      editableCap(b, 'quad', 'xl', c.xl, '왼쪽 이름'),
      editableCap(b, 'quad', 'xh', c.xh, '오른쪽 이름')),
  ));
  askLine(b, stage);
}

/* 흐름. 가로는 단계, 세로는 갈래.

   갈래가 하나면 한 줄이고, 늘리면 같은 단계 축 위로 흐름이 여러 줄이 된다.
   "A안 / B안"으로 이름 붙이면 갈라지는 흐름이고, "서버 / 앱"으로 붙이면 나란히 가는 흐름이다.
   빈 칸은 그 갈래가 그 단계에서 하는 일이 없다는 뜻이다.
   배치는 여전히 사람이 정하지 않는다. 정하는 것은 어느 칸이냐 하나뿐이다. */

const FLOW_MAX_STAGE = 6;
const FLOW_MAX_LANE = 5;

/* 단계 이름의 기본값은 상황이 정한다. 빈 칸 셋만 주면 무엇을 적어야 할지 알기 어려워
   이 보기를 쓰지 않게 된다. 적어 둔 것은 언제든 고칠 수 있다. */
function flowCfg(b) {
  const c = b.cfg.flow || {};
  const t = tune(b);
  return {
    stages: c.stages && c.stages.length ? c.stages : t.line.slice(),
    lanes: c.lanes && c.lanes.length ? c.lanes : [{ k: 'l0', n: t.lane }],
  };
}

const flowKey = (i, lane) => `s${i}-${lane}`;

/* 이전 판의 흐름은 한 줄뿐이라 칸 이름이 's0' 이었다. 첫 갈래로 옮긴다. */
function migrateFlow(b) {
  const s = Store.slots(b, 'flow');
  const legacy = Object.entries(s).filter(([, sk]) => /^s\d+$/.test(sk));
  if (!legacy.length) return;
  const lane = flowCfg(b).lanes[0].k;
  legacy.forEach(([pid, sk]) => Store.put(b.id, 'flow', pid, `${sk}-${lane}`));
}

function viewFlow(b, stage) {
  migrateFlow(b);
  const { stages, lanes } = flowCfg(b);
  const save = (patch) => { Store.cfg(b.id, 'flow', patch); render(); };
  const showLane = lanes.length > 1;

  const cols = stages.map(() => 'minmax(180px, 1fr)').join(' 28px ');
  const grid = el('div', {
    class: 'flowgrid',
    style: `grid-template-columns:${showLane ? '104px ' : ''}${cols}`,
  });

  // 첫 줄은 단계 이름
  if (showLane) grid.append(el('div', { class: 'corner' }));
  stages.forEach((name, i) => {
    if (i) grid.append(el('div', { class: 'arrow' }, '→'));
    const inp = el('input', { type: 'text', value: name, placeholder: `${i + 1}단계` });
    inp.addEventListener('change', () =>
      save({ stages: stages.map((x, j) => (j === i ? inp.value : x)) }));
    grid.append(el('div', { class: 'st-head' }, inp));
  });

  // 갈래마다 한 줄
  lanes.forEach((ln, li) => {
    if (showLane) {
      const inp = el('input', { type: 'text', value: ln.n, placeholder: `줄 ${li + 1}` });
      inp.addEventListener('change', () =>
        save({ lanes: lanes.map((x, j) => (j === li ? { ...x, n: inp.value } : x)) }));
      grid.append(el('div', { class: 'lane-head' }, inp));
    }
    stages.forEach((_, i) => {
      if (i) grid.append(el('div', { class: 'link' }, el('i', {})));
      grid.append(slotNode(b, flowKey(i, ln.k), null, { hint: '' }));
    });
  });

  stage.append(el('div', { class: 'flow-wrap' }, grid));

  const clear = (hit) => {
    const s = Store.slots(b, 'flow');
    for (const [pid, sk] of Object.entries(s)) if (hit(sk)) Store.put(b.id, 'flow', pid, null);
  };

  stage.append(el('div', { class: 'flow-ctl' },
    stages.length < FLOW_MAX_STAGE
      ? el('button', { class: 'ghost', onclick: () => save({ stages: [...stages, ''] }) }, '＋ 단계')
      : null,
    stages.length > 2
      ? el('button', {
          class: 'ghost',
          onclick: () => {
            const last = stages.length - 1;
            clear((sk) => sk.startsWith(`s${last}-`));
            save({ stages: stages.slice(0, -1) });
          },
        }, '－ 단계')
      : null,
    el('span', { class: 'sep' }),
    lanes.length < FLOW_MAX_LANE
      ? el('button', {
          class: 'ghost',
          onclick: () => {
            const n = Math.max(...lanes.map((x) => Number(String(x.k).slice(1)) || 0)) + 1;
            save({ lanes: [...lanes, { k: 'l' + n, n: '' }] });
          },
        }, '＋ 줄')
      : null,
    lanes.length > 1
      ? el('button', {
          class: 'ghost',
          onclick: () => {
            const gone = lanes[lanes.length - 1].k;
            clear((sk) => sk.endsWith('-' + gone));
            save({ lanes: lanes.slice(0, -1) });
          },
        }, '－ 줄')
      : null,
  ));
}

function viewTodo(b, stage) {
  const cfg = b.cfg.todo || {};
  const cats = todoCats(b);
  const view = cfg.view || 'all';
  const save = (patch) => { Store.cfg(b.id, 'todo', patch); render(); };
  const s = Store.slots(b, 'todo');
  const only = (p) => view === 'all' || p.cat === view;
  const finish = (p) => {
    Store.put(b.id, 'todo', p.id, 'done');
    if (b.star === p.id) Store.star(b.id, p.id);   // 끝난 것이 계속 "지금"일 수는 없다
    render();
  };

  /* --- 대분류 --- */
  const bar = el('div', { class: 'cats' },
    el('button', {
      class: 'cat-tab' + (view === 'all' ? ' on' : ''),
      onclick: () => save({ view: 'all' }),
    }, '전체'));
  cats.forEach((c, i) => {
    if (view === c.k) {
      // 고른 분류는 그 자리에서 이름을 고친다. 편집 화면을 따로 열지 않는다
      const inp = el('input', { class: 'cat-tab on', type: 'text', value: c.n, placeholder: `분류 ${i + 1}` });
      inp.addEventListener('change', () =>
        save({ cats: cats.map((x, j) => (j === i ? { ...x, n: inp.value } : x)) }));
      bar.append(inp);
    } else {
      bar.append(el('button', {
        class: 'cat-tab', onclick: () => save({ view: c.k }),
      }, c.n || `분류 ${i + 1}`));
    }
  });
  bar.append(el('span', { class: 'sep' }));
  if (cats.length < 6) {
    bar.append(el('button', {
      class: 'ghost sm',
      onclick: () => {
        const n = Math.max(...cats.map((x) => Number(String(x.k).slice(1)) || 0)) + 1;
        save({ cats: [...cats, { k: 'c' + n, n: '' }] });
      },
    }, '＋ 분류'));
  }
  if (view !== 'all' && cats.length > 1) {
    bar.append(el('button', {
      class: 'ghost sm',
      onclick: () => {
        // 분류만 없앤다. 그 안의 할 일은 지우지 않는다
        b.pieces.filter((x) => x.cat === view).forEach((x) => Store.setMeta(b.id, x.id, { cat: '' }));
        save({ cats: cats.filter((c) => c.k !== view), view: 'all' });
      },
    }, '－ 분류'));
  }
  stage.append(bar);

  /* --- 오늘 띠. 시각을 적는 곳이 아니라 순서에서 시각이 나오는 곳 --- */
  const t = today();
  const hm = nowHM();
  const todays = b.pieces
    .filter((x) => only(x) && x.due === t && s[x.id] !== 'done' && s[x.id] !== 'some')
    .sort(byPlan(b, 'todo'));

  // 위아래로 옮기면 그 순서가 그대로 시작 시각이 된다
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= todays.length) return;
    const seq = todays.slice();
    const [x] = seq.splice(i, 1);
    seq.splice(j, 0, x);
    Store.setOrder(b.id, 'todo', seq.map((q) => q.id));
    render();
  };

  /* 줄 높이가 걸리는 시간을 나타낸다.

     시각을 숫자로만 표시하면 10분짜리와 3시간짜리가 같은 높이라 하루가 찼는지 계산해야
     한다. 최소 높이를 두어 짧은 줄도 읽히게 하고, 최대 높이를 두어 한 항목이 화면을
     다 차지하지 않게 한다. 숫자는 그대로 옆에 남는다. */
  const rowH = (m) => Math.round(Math.min(190, 34 + (m || 0) * 0.7));

  const startHM = /^\d{2}:\d{2}$/.test(cfg.start || '') ? cfg.start : hm;
  let cur = toMin(startHM);
  const at = todays.map((x) => { const a = cur; cur += (x.mins || 0); return a; });
  const total = cur - toMin(startHM);
  const noEst = todays.filter((x) => !x.mins).length;

  const starred = b.pieces.find((x) => x.id === b.star && s[x.id] !== 'done');
  const nowPiece = starred || todays[0]
    || b.pieces.filter((x) => only(x) && s[x.id] === 'now').sort(byPlan(b, 'todo'))[0] || null;

  stage.append(el('div', { class: 'nowline' },
    el('span', { class: 'lbl' }, '지금'),
    nowPiece
      ? el('span', { class: 'txt' }, nowPiece.text)
      : el('span', { class: 'txt dim' }, '할 일 칸에 하나 놓거나 별을 찍으면 여기 표시.'),
    nowPiece && nowPiece.mins ? el('span', { class: 'dur' }, humanMin(nowPiece.mins)) : null,
    nowPiece ? el('button', { class: 'mini', onclick: () => finish(nowPiece) }, '✓ 완료') : null,
  ));

  const head = el('div', { class: 'head' },
    el('span', { class: 'ttl' }, `오늘 · ${Number(t.slice(5, 7))}월 ${Number(t.slice(8))}일`));
  const st = el('input', { class: 'start', type: 'time', value: startHM, title: '시작 시각' });
  st.addEventListener('change', () => save({ start: st.value }));
  head.append(el('span', { class: 'lbl2' }, '시작'), st);
  head.append(el('span', { class: 'sum' }, todays.length
    ? `쭉 하면 ${humanMin(total) || '0분'} · ${fromMin(cur)} 끝`
    + (noEst ? ` (${noEst}개는 시간 미정)` : '')
    : ''));
  const strip = el('div', { class: 'daystrip' }, head);

  if (!todays.length) {
    strip.append(el('div', { class: 'empty' }, '오늘 날짜를 붙인 것 없음. 카드의 “오늘”을 누르면 여기 표시.'));
  } else {
    todays.forEach((x, i) => {
      strip.append(el('div', {
        class: 'row' + (nowPiece && x.id === nowPiece.id ? ' on' : ''),
        style: `min-height:${rowH(x.mins)}px`,
        onclick: (e) => {
          if (e.target.closest('button')) return;
          picked = picked === x.id ? null : x.id;
          render();
        },
      },
        el('span', { class: 'tm' }, fromMin(at[i])),
        el('span', { class: 'bar' + (x.mins ? '' : ' none') }),
        el('span', { class: 'dur' + (x.mins ? '' : ' none') }, x.mins ? humanMin(x.mins) : '시간 미정'),
        x.cat ? el('span', { class: 'tag' }, catName(b, x.cat)) : null,
        el('span', { class: 'txt' }, x.text),
        el('span', { class: 'ord' },
          el('button', { class: 'mini', title: '위로', onclick: () => move(i, -1) }, '↑'),
          el('button', { class: 'mini', title: '아래로', onclick: () => move(i, 1) }, '↓')),
        el('button', { class: 'mini ok', title: '완료', onclick: () => finish(x) }, '✓'),
      ));
    });
  }
  stage.append(strip);

  /* --- 전체 --- */
  stage.append(el('div', { class: 'todo' },
    TODO_SLOTS.map(([k, label]) => slotNode(b, k, label, {
      hint: k === 'done' ? '끝난 것이 쌓이는 자리' : '조각을 끌어다 놓기',
      only, sort: byPlan,
    }))));
  askLine(b, stage);
}

function viewPrep(b, stage) {
  const c = b.cfg.prep || {};
  const goal = PREP_GOALS.some(([k]) => k === c.goal) ? c.goal : null;
  const ask = PREP_ASK[goal || 'none'];
  const save = (patch) => { Store.cfg(b.id, 'prep', patch); render(); };

  const bar = el('div', { class: 'goalbar' },
    el('span', { class: 'lbl' }, '이 자리의 목적'),
    PREP_GOALS.map(([k, n]) => el('button', {
      class: 'goal' + (goal === k ? ' on' : ''),
      onclick: () => save({ goal: goal === k ? null : k }),
    }, n)),
    el('span', { class: 'sep' }),
  );
  const mins = el('input', {
    class: 'mins', type: 'text', value: c.mins || '', placeholder: '분',
    title: '예정 시간 (분)',
  });
  mins.addEventListener('change', () => save({ mins: mins.value.trim() }));
  bar.append(mins, el('span', { class: 'lbl' }, '분 안에'));
  stage.append(bar);

  if (!goal) {
    stage.append(el('p', { class: 'nudge' },
      '목적 하나 선택 — 네 칸의 질문이 목적마다 다름.'));
  }

  stage.append(el('div', { class: 'prep board-h' },
    PREP_SLOTS.map((k) => {
      const [label, hint] = ask[k];
      return slotNode(b, k, label, { hint });
    })));

  const off = handOff(b, ['say', 'ask'], 'meet', '회의');
  if (off) stage.append(off);
}

/* 위치별 한 줄.

   영상을 다 본 뒤에 쓰는 「한 줄」 하나로는 긴 내용을 담을 수 없고, 다 보고 나면 앞부분
   기억이 흐려진다. 파트를 지날 때마다 그 자리에서 한 줄로 요약해 두면 나중에 그 줄만
   이어 읽어도 전체가 파악된다. 그 줄이 목차이자 요약이다.

   요약이 곧 학습이다. 조각 다섯 개를 한 줄로 줄이지 못하면 아직 그 파트를 이해하지 못한 것이다.

   줄은 판에 붙고(cfg.study.lines) 조각은 위치로 그 줄에 묶인다. 조각을 지워도 줄은 남는다. */

// 12:30 · 1:05:20 · p.42 가 섞여 있어도 사람이 읽는 순서로 정렬한다
function locRank(v) {
  const t = v.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (t) return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3] || 0);
  const n = v.match(/(\d+)/);
  return n ? 1e7 + Number(n[1]) : 2e7;
}

function studyLocs(b) {
  const s = Store.slots(b, 'study');
  const seen = new Map();
  b.pieces.forEach((p) => {
    const k = (p.loc || '').trim();
    if (!k) return;
    const at = seen.get(k) || { loc: k, n: 0, mine: 0 };
    at.n += 1;
    if (s[p.id] === 'mine') at.mine += 1;
    seen.set(k, at);
  });
  const lines = (b.cfg.study || {}).lines || {};
  Object.keys(lines).forEach((k) => {
    if (!seen.has(k)) seen.set(k, { loc: k, n: 0, mine: 0 });
  });
  return [...seen.values()].sort((x, y) => locRank(x.loc) - locRank(y.loc));
}

function studyLineBar(b, stage) {
  const cfg = b.cfg.study || {};
  const lines = cfg.lines || {};
  const locs = studyLocs(b);
  const box = el('div', { class: 'locbar' });

  const done = locs.filter((x) => (lines[x.loc] || '').trim()).length;
  /* 접을 수 있게 둔다. 파트가 여럿이면 이 표만으로 화면이 가득 차는데, 적는 동안에는
     칸이 먼저 보여야 한다. 접힘은 서버 저장소의 화면 설정에 남는다. */
  const open = Store.ui('locbarOpen') !== false;
  box.classList.toggle('shut', !open);
  box.append(el('div', { class: 'cap' },
    el('button', {
      class: 'twist', title: open ? '접기' : '펼치기',
      onclick: () => { Store.ui('locbarOpen', !open); render(); },
    }, open ? '▾' : '▸'),
    el('b', {}, '위치별 한 줄'),
    el('span', {}, locs.length ? `${done} / ${locs.length}` : '조각에 위치를 적으면 여기로'),
    hereAt ? el('button', {
      class: 'ghost sm', onclick: () => { hereAt = null; render(); },
    }, '전부 보기') : null));

  if (!open) { stage.append(box); return; }

  locs.forEach((x) => {
    const row = el('div', { class: 'locrow' + (hereAt === x.loc ? ' on' : '') });
    row.append(el('button', {
      class: 'at', title: '이 파트만 보기',
      onclick: () => {
        const on = hereAt !== x.loc;
        hereAt = on ? x.loc : null;
        // 그 파트를 들여다보는 동안 새로 담는 조각도 그 파트에 붙어야 한다.
        // 안 맞추면 방금 적은 것이 걸러져 화면에서 사라진다
        if (on && (cfg.loc || '') !== x.loc) Store.cfg(b.id, 'study', { loc: x.loc });
        render();
      },
    }, x.loc));
    const inp = el('input', {
      class: 'one', type: 'text', value: lines[x.loc] || '',
      placeholder: '이 파트를 한 줄로',
    });
    inp.addEventListener('change', () => {
      const next = { ...lines };
      const v = inp.value.trim();
      if (v) next[x.loc] = v; else delete next[x.loc];
      Store.cfg(b.id, 'study', { lines: next });
      render();
    });
    row.append(inp);
    row.append(el('span', { class: 'n', title: '이 위치의 조각 수' }, String(x.n)));
    // 그대로 옮기기만 하고 내 말로 바꾸지 않은 파트. 아직 이해하지 못한 부분이다
    if (x.n && !x.mine) row.append(el('span', { class: 'warn', title: '내 말로 옮긴 것 없음' }, '내 말 없음'));
    box.append(row);
  });

  stage.append(box);
}

/* 접힌 의문 줄. 회의의 들은 것 줄과 같은 모양이고 같은 뜻이다.
   본문이 아니라 옆에 쌓이는 것이라 접어 두되, 개수는 항상 보인다. */
function askLine(b, stage) {
  if (!ASK_AS_LINE.has(b.frame) || b.frame === 'meet') return;   // 회의는 자기 줄이 따로 있다
  const s = Store.slots(b, b.frame);
  const n = b.pieces.filter((x) => s[x.id] === 'ask').length;
  const open = meetOpen.ask;

  const line = el('div', {
    class: 'heardline' + (picked ? ' hot' : '') + (open ? ' open' : ''), 'data-more': 'ask',
  },
    el('span', { class: 'lbl' }, '의문'),
    el('span', { class: 'n' }, String(n)),
    el('button', {
      class: 'ghost sm',
      onclick: (e) => { e.stopPropagation(); meetOpen.ask = !open; render(); },
    }, open ? '접기' : '펼치기'),
    el('span', { class: 'drop' }, '여기에 놓기'));
  line.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (!picked) return;
    Store.put(b.id, b.frame, picked, 'ask');
    picked = null;
    render();
  });
  dropTarget(line, (id) => {
    Store.put(b.id, b.frame, id, 'ask');
    render();
  });
  stage.append(line);
  if (open) {
    stage.append(el('div', { class: 'heardbox' },
      slotNode(b, 'ask', null, { hint: '지금은 답을 찾지 않는 자리. ⌘⇧Enter 로 바로 넣기' })));
  }
}

function viewStudy(b, stage) {
  const cfg = b.cfg.study || {};
  const save = (patch) => { Store.cfg(b.id, 'study', patch); render(); };

  /* 출처·한 줄·덮기를 한 줄로 접는다.

     셋에 각각 줄을 주고 입력칸을 펼쳐 두면 판마다 한 번 적는 값에 화면을 계속
     할당하게 된다. 확인 결과: 420px 창에서 출처·한 줄·덮기 세 줄이 182px 를 차지했다.
     적은 것은 딱지로 보여 주고, 적지 않은 것은 「＋」 하나로 줄인다. */
  const cfgChip = (key, label, ph) => {
    const val = (cfg[key] || '').trim();
    if (cfgOpen.has(key)) {
      const inp = el('input', { class: 'locin wide', type: 'text', value: val, placeholder: ph });
      let done = false;
      const shut = (keep) => {
        if (done) return;
        done = true;
        cfgOpen.delete(key);
        if (keep) save({ [key]: inp.value.trim() });
        else render();
      };
      inp.addEventListener('change', () => shut(true));
      inp.addEventListener('blur', () => shut(true));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); shut(false); }
      });
      setTimeout(() => { if (inp.isConnected) inp.focus(); }, 0);
      return inp;
    }
    return el('button', {
      class: 'chip ' + (val ? 'at' : 'add'), title: ph,
      onclick: () => { cfgOpen.add(key); render(); },
    }, val ? `${label} ${short(val, 28)}` : `＋ ${label}`);
  };

  const head = el('div', { class: 'srcbar' });
  head.append(cfgChip('src', '출처', '보고 있는 것 — 제목이나 주소'));
  if (/^https?:\/\//.test(cfg.src || '') && !cfgOpen.has('src')) {
    head.append(el('a', { class: 'open', href: cfg.src, target: '_blank', rel: 'noreferrer' }, '열기 ↗'));
  }
  head.append(cfgChip('sum', '한 줄', '다 보고 나서 — 한 줄 요약'));
  // 덮는 단추는 덮이는 칸과 같은 줄에 둔다. 멀리 떨어뜨리면 무엇을 덮는지 알 수 없다
  head.append(el('button', {
    class: 'ghost sm' + (cfg.hide ? ' on' : ''),
    title: '원문을 덮고 내 말만 보고 되짚기',
    onclick: () => save({ hide: !cfg.hide }),
  }, cfg.hide ? '그대로 보기' : '그대로 숨기기'));
  stage.append(head);

  studyLineBar(b, stage);

  const grid = el('div', { class: 'study board-h' });
  STUDY_SLOTS.forEach(([k, label, hint]) => {
    if (k === 'quote' && cfg.hide) {
      const n = b.pieces.filter((x) => Store.slots(b, 'study')[x.id] === 'quote'
        && (!hereAt || (x.loc || '').trim() === hereAt)).length;
      grid.append(el('div', { class: 'slot covered', 'data-slot': 'quote' },
        el('div', { class: 'cap' }, label),
        el('div', { class: 'coverline' }, `${n}개 숨김`),
        el('div', { class: 'empty' }, '옆 칸의 내 말만 보고 말이 되는지 확인. 막히는 자리가 아직 모르는 자리.')));
      return;
    }
    grid.append(slotNode(b, k, label, { hint, byLoc: usesHere(b) }));
  });
  stage.append(grid);
}

/* 판에서 판으로. 한 번 누르면 끝난다.

   준비 → 회의 → 할 일이 실제 순서인데 셋이 연결되어 있지 않으면, 준비 판에서 정리한 것이
   회의 판에 오지 않고 회의에서 나온 할 것도 회의록에만 남는다.

   받는 판을 고르게 하지 않는다. 선택 창이 뜨면 그 자리에서 누르지 않게 된다.
   처음 누를 때 판을 만들고 그 id 를 이 판에 적어 둔다. 다음부터는 같은 판으로 간다.
   그 판을 지웠으면 새로 만든다. 복사이므로 이쪽 기록은 그대로 남는다. */
function handOff(b, keys, kind, tail) {
  const s = Store.slots(b, b.frame);
  const ids = b.pieces.filter((p) => keys.includes(s[p.id])).map((p) => p.id);
  if (!ids.length) return null;

  const cfg = b.cfg[b.frame] || {};
  const name = KINDS[kind].name;

  return el('div', { class: 'handoff' },
    el('button', {
      class: 'ghost',
      onclick: () => {
        let to = Store.boards().find((x) => x.id === cfg.sentTo);
        if (!to) {
          to = Store.addBoard({
            title: `${b.title || '제목 없음'} · ${tail}`, kind, view: 'box', frame: kind,
          });
          Store.open(b.id);                       // 만들면서 옮겨 간 것을 되돌린다
          Store.cfg(b.id, b.frame, { sentTo: to.id });
        }
        const n = Store.copyPieces(b.id, to.id, ids);
        say(n ? `${to.title} 판으로 ${n}개` : '이미 다 보냄');
        render();
      },
    }, `${ids.length}개를 ${name} 판으로`),
    el('span', {}, '베끼는 것이라 이 판의 기록은 그대로'));
}

function viewMeet(b, stage) {
  const cfg = b.cfg.meet || {};
  const save = (patch) => { Store.cfg(b.id, 'meet', patch); render(); };
  const s = Store.slots(b, 'meet');

  const bar = el('div', { class: 'srcbar' });
  const who = el('input', {
    class: 'src', type: 'text', value: cfg.who || '', placeholder: '누가 왔나 — 쉼표로',
  });
  who.addEventListener('change', () => save({ who: who.value }));
  bar.append(el('span', { class: 'lbl' }, '참석'), who);
  stage.append(bar);

  // 담당자나 기한이 빈 할 일은 실행되지 않는다. 개수만 세어 보여 준다
  const acts = b.pieces.filter((p) => s[p.id] === 'todo' || s[p.id] === 'open');
  const lack = acts.filter((p) => !p.owner || !p.due).length;
  if (lack) {
    stage.append(el('p', { class: 'nudge' },
      `담당자나 기한 빈칸 ${lack}개. 둘 다 있어야 실제로 실행.`));
  }

  stage.append(el('div', { class: 'meet board-h' },
    MEET_MAIN.map(([k, label]) => slotNode(b, k, label, { hint: '조각을 골라 여기에' }))));

  MEET_MORE.forEach(([k, label, hint]) => {
    const open = meetOpen[k];
    const n = b.pieces.filter((x) => s[x.id] === k).length;
    const line = el('div', {
      class: 'heardline' + (picked ? ' hot' : '') + (open ? ' open' : ''),
      'data-more': k,
    },
      el('span', { class: 'lbl' }, label),
      el('span', { class: 'n' }, String(n)),
      el('button', {
        class: 'ghost sm',
        onclick: (e) => { e.stopPropagation(); meetOpen[k] = !open; render(); },
      }, open ? '접기' : '펼치기'),
      el('span', { class: 'drop' }, '여기에 놓기'));
    line.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (!picked) return;
      Store.put(b.id, 'meet', picked, k);
      picked = null;
      render();
    });
    dropTarget(line, (id) => {
      Store.put(b.id, 'meet', id, k);
      render();
    });
    stage.append(line);
    if (open) stage.append(el('div', { class: 'heardbox' }, slotNode(b, k, null, { hint })));
  });

  const off = handOff(b, ['todo'], 'todo', '할 일');
  if (off) stage.append(off);

  const nx = el('div', { class: 'srcbar nextbar' });
  const on = el('input', { class: 'due', type: 'date', value: cfg.nextOn || '', title: '다음 회의 날짜' });
  on.addEventListener('change', () => save({ nextOn: on.value }));
  const ag = el('input', {
    class: 'src', type: 'text', value: cfg.next || '', placeholder: '다음에 다룰 것',
  });
  ag.addEventListener('change', () => save({ next: ag.value }));
  nx.append(el('span', { class: 'lbl' }, '다음'), on, ag);
  stage.append(nx);
}

function viewTree(b, stage) {
  const s = Store.slots(b, 'tree');
  const childrenOf = (pid) => b.pieces.filter((p) => s[p.id] === pid);

  const here = (parentKey, label) => picked
    ? el('button', {
        class: 'here',
        onclick: () => { Store.put(b.id, 'tree', picked, parentKey); picked = null; render(); },
      }, label)
    : null;

  // 자기 자신이나 자손 밑으로는 옮길 수 없다. 순환이 생기면 화면이 그려지지 않는다
  const isUnder = (id, ancestor) => {
    let cur = s[id];
    while (cur && cur !== 'root') {
      if (cur === ancestor) return true;
      cur = s[cur];
    }
    return false;
  };

  const nodeFor = (p, depth) => el('div', { class: 'node' },
    dropTarget(
      pieceNode(b, p, true),
      (id) => { Store.put(b.id, 'tree', id, p.id); render(); },
      (id) => depth < 2 && id !== p.id && !isUnder(p.id, id),
    ),
    (childrenOf(p.id).length || (picked && picked !== p.id && depth < 2))
      ? el('div', { class: 'kids' },
          childrenOf(p.id).map((c) => nodeFor(c, depth + 1)),
          depth < 2 ? here(p.id, '여기 아래로') : null)
      : null,
  );

  const tops = childrenOf('root');
  stage.append(dropTarget(el('div', { class: 'tree' },
    el('div', { class: 'rootline' },
      el('b', {}, tune(b).treeTop),
      el('span', {}, tune(b).treeAsk)),
    tops.map((p) => nodeFor(p, 0)),
    here('root', `${tune(b).treeTop}에 놓기`),
    !tops.length && !picked
      ? el('div', { class: 'empty' }, `조각 하나를 골라 「${tune(b).treeTop}」에 놓기부터.`) : null,
  ), (id) => { Store.put(b.id, 'tree', id, 'root'); render(); }));
}

/* ---------- 이음 ----------

   다른 프레임은 모두 칸에 카드를 넣는 동작이다. 칸은 같은 무리라는 것만 나타내고
   무엇 때문에 무엇인지는 나타내지 못해, 관계가 화면에 남지 않는다. 조각을 늘려도
   정리되지 않는 부분이 여기다.

   선을 그으면 관계를 눈으로 확인할 수 있고(Larkin & Simon 1987), 선에 뜻을 붙이면
   더 정확해진다(Novak). 그래서 이 보기의 제약은 하나다. 이을 때 뜻을 고르게 한다.

   위치는 사람이 정하지 않는다. 자유 캔버스의 배치 부담이 이 판에서 피하려는 것이라,
   관계만 지정하면 그림이 자동으로 그려진다. 원인이 왼쪽, 결과가 오른쪽이다.

   동작은 둘뿐이다. 카드를 카드 위로 끌면 이어지고, 선을 누르면 뜻이 바뀐다. */

function linkLayout(b) {
  const alive = new Set(b.pieces.map((p) => p.id));
  const ls = Store.links(b).filter((l) => alive.has(l.a) && alive.has(l.z));
  const dir = ls.filter((l) => l.k !== 'same');

  const nodes = new Set();
  ls.forEach((l) => { nodes.add(l.a); nodes.add(l.z); });

  // 층 매기기. 들어오는 선이 없는 것이 맨 왼쪽
  const left = {};
  nodes.forEach((n) => { left[n] = 0; });
  dir.forEach((l) => { left[l.z] += 1; });
  const layer = {};
  const q = [];
  nodes.forEach((n) => { if (!left[n]) { layer[n] = 0; q.push(n); } });
  for (let h = 0; h < q.length; h += 1) {
    const n = q[h];
    dir.filter((l) => l.a === n).forEach((l) => {
      layer[l.z] = Math.max(layer[l.z] === undefined ? 0 : layer[l.z], layer[n] + 1);
      left[l.z] -= 1;
      if (left[l.z] === 0) q.push(l.z);
    });
  }
  // 순환하는 것. 층을 받지 못한 항목이라 맨 뒤에 두고 따로 알린다
  const loop = [...nodes].filter((n) => layer[n] === undefined);
  const deep = Object.values(layer).length ? Math.max(...Object.values(layer)) : 0;
  loop.forEach((n) => { layer[n] = deep + 1; });

  const cols = [];
  [...nodes].forEach((n) => {
    (cols[layer[n]] = cols[layer[n]] || []).push(n);
  });

  // 같은 층 안의 위아래. 앞 층에서 연결된 위치의 평균을 따라가면 선이 덜 겹친다
  const at = {};
  cols.forEach((col, ci) => {
    if (ci === 0) { col.forEach((n, i) => { at[n] = i; }); return; }
    const key = (n) => {
      const ups = dir.filter((l) => l.z === n && at[l.a] !== undefined).map((l) => at[l.a]);
      return ups.length ? ups.reduce((x, y) => x + y, 0) / ups.length : 999;
    };
    col.sort((x, y) => key(x) - key(y));
    col.forEach((n, i) => { at[n] = i; });
  });

  const deg = {};
  ls.forEach((l) => { deg[l.a] = (deg[l.a] || 0) + 1; deg[l.z] = (deg[l.z] || 0) + 1; });

  // 아직 아무 데도 잇지 않은 것. 맨 왼쪽에 따로 두어 시작 지점을 만들고,
  // 그 줄의 길이가 아직 정리하지 않은 양을 나타낸다
  const free = b.pieces.filter((p) => !nodes.has(p.id)).map((p) => p.id);

  return { ls, cols, deg, loop: new Set(loop), free };
}

function viewLink(b, stage) {
  const { ls, cols, deg, loop, free } = linkLayout(b);
  const byId = Object.fromEntries(b.pieces.map((p) => [p.id, p]));

  stage.append(el('div', { class: 'linkhint' },
    el('b', {}, '조각을 조각 위로 끌기'),
    el('span', {}, '왼쪽이 원인, 오른쪽이 결과'),
    el('span', { class: 'keys' }, tune(b).linkAsk)));

  const nodeEl = {};
  const mkNode = (id) => {
    const p = byId[id];
    const d = deg[id] || 0;
    const node = el('div', {
      class: 'lnode' + (picked === id ? ' picked' : '')
        + (b.star === id ? ' starred' : '')
        + (loop.has(id) ? ' loop' : '')
        + (d >= 4 ? ' big' : d >= 2 ? ' mid' : ''),
      onclick: (e) => {
        if (e.target.closest('button')) return;
        if (picked && picked !== id) { Store.link(b.id, picked, id, 'cause'); picked = null; }
        else picked = picked === id ? null : id;
        render();
      },
    },
      el('div', { class: 't' }, p.text),
      d >= 2 ? el('span', { class: 'deg', title: '걸린 선 수' }, String(d)) : null);
    dragSource(node, id);
    dropTarget(node, (from) => { Store.link(b.id, from, id, 'cause'); render(); }, (from) => from !== id);
    nodeEl[id] = node;
    return node;
  };

  const wrap = el('div', { class: 'linkwrap' });
  const canvas = el('div', { class: 'linkcanvas' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'linksvg');
  canvas.append(svg);

  const board = el('div', { class: 'linkcols' });
  // 잇지 않은 것이 맨 왼쪽이고, 이으면 오른쪽으로 옮겨 가므로 줄어드는 것이 보인다
  if (free.length) {
    board.append(el('div', { class: 'linkcol free' },
      el('div', { class: 'cap' }, `아직 안 이은 것 ${free.length}`),
      free.map(mkNode)));
  }
  cols.forEach((col) => board.append(el('div', { class: 'linkcol' }, col.map(mkNode))));
  if (!b.pieces.length) {
    board.append(el('div', { class: 'empty' }, '왼쪽 아래 보관함 칸에 한 줄씩 적으면 여기로.'));
  } else if (!ls.length) {
    // 아직 하나도 안 이었으면 화면이 통째로 빈다. 말로 적는 대신 결과를 그대로 보여 준다
    board.append(el('div', { class: 'linkdemo' },
      el('div', { class: 'cap' }, '이으면 이렇게'),
      el('div', { class: 'row' },
        el('span', { class: 'box' }, '광고비 1달에 1억'),
        el('span', { class: 'arw' }, linkName(b, 'cause')),
        el('span', { class: 'box' }, '구독제는 무리'))));
  }
  canvas.append(board);
  wrap.append(canvas);
  stage.append(wrap);

  if (loop.size) {
    stage.append(el('p', { class: 'nudge' },
      `돌고 도는 자리 ${loop.size}개. 원인과 결과가 서로를 가리키는 중 — 선 하나를 눌러 뜻 바꾸기.`));
  }

  // 그림은 조각이 배치된 뒤에 그린다. 위치를 측정해 선을 얹으므로 순서가 중요하다
  requestAnimationFrame(() => {
    drawLinks(b, canvas, svg, nodeEl, ls);
    fitCanvas(wrap, canvas);
  });
}

/* 지도는 한 화면에 들어와야 한다. 넘치면 줄인다. 글자가 작아져도 전체 모양이 보이는 쪽이
   낫다. 다만 읽을 수 없을 만큼 줄이지는 않고, 그 아래로는 스크롤해서 본다. */
function fitCanvas(wrap, canvas) {
  canvas.style.transform = '';
  canvas.style.width = '';
  const room = wrap.clientWidth;
  const need = canvas.scrollWidth;
  if (!room || need <= room) return;
  const k = Math.max(0.6, room / need);
  canvas.style.transformOrigin = 'top left';
  canvas.style.transform = `scale(${k.toFixed(3)})`;
  canvas.style.width = `${100 / k}%`;
}

function drawLinks(b, canvas, svg, nodeEl, ls) {
  const box = canvas.getBoundingClientRect();
  if (!box.width) return;
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.setAttribute('width', String(box.width));
  svg.setAttribute('height', String(box.height));
  svg.innerHTML = '';

  const mk = (name, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
  };
  const at = (id) => {
    const r = nodeEl[id].getBoundingClientRect();
    return {
      l: r.left - box.left, r: r.right - box.left,
      t: r.top - box.top, bm: r.bottom - box.top,
      cx: r.left + r.width / 2 - box.left, cy: r.top + r.height / 2 - box.top,
    };
  };

  canvas.querySelectorAll('.llabel').forEach((n) => n.remove());

  ls.forEach((l) => {
    if (!nodeEl[l.a] || !nodeEl[l.z]) return;
    const A = at(l.a);
    const Z = at(l.z);
    const fwd = A.cx <= Z.cx;
    const x1 = fwd ? A.r : A.l;
    const x2 = fwd ? Z.l : Z.r;
    const dx = Math.max(24, Math.abs(x2 - x1) * 0.45);
    const d = `M ${x1} ${A.cy} C ${x1 + (fwd ? dx : -dx)} ${A.cy}, ${x2 - (fwd ? dx : -dx)} ${Z.cy}, ${x2} ${Z.cy}`;
    svg.append(mk('path', {
      d, fill: 'none', class: `ln ${l.k}`,
      'marker-end': l.k === 'same' ? '' : `url(#ar-${l.k})`,
    }));

    // 뜻은 선 위에 적는다. 누르면 한 칸씩 돌고 마지막에서 끊긴다
    const lab = el('button', {
      class: `llabel ${l.k}`,
      title: '누르면 뜻 바꾸기. 한 바퀴 돌면 선 끊기',
      onclick: (e) => { e.stopPropagation(); Store.cycleLink(b.id, l.a, l.z); render(); },
    }, linkName(b, l.k));
    lab.style.left = `${(x1 + x2) / 2}px`;
    lab.style.top = `${(A.cy + Z.cy) / 2}px`;
    canvas.append(lab);
  });

  const defs = mk('defs', {});
  ['cause', 'block'].forEach((k) => {
    const m = mk('marker', {
      id: `ar-${k}`, viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse',
    });
    m.append(mk('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: `head ${k}` }));
    defs.append(m);
  });
  svg.prepend(defs);
}

// frame(= 상황이거나 보기) 마다 그리는 함수
/* 배율. 지도는 줄여서 전체를 보고 키워서 읽는다.

   자동으로 맞춰 줄이면 창 너비 459 에서 0.6 배가 적용되어 카드가 101px 로 줄고 글자를
   읽을 수 없다. 줄이는 것은 사람이 정하고, 겹치지 않게
   벌리는 것은 layoutMap 이 한다. 둘은 다른 일이다. */
// 20% 에서 멈추면 「맞춤」이 큰 판을 다 담지 못한다(확인 결과: 조각 60 · 캔버스 높이 3529).
const MAP_Z_MIN = 0.08;
const MAP_Z_MAX = 2;
let mapZoom = 1;
let mapZoomRead = false;
function zoomNow() {
  if (!mapZoomRead) {
    mapZoomRead = true;
    const v = Number(Store.ui('mapZoom'));
    mapZoom = v >= MAP_Z_MIN && v <= MAP_Z_MAX ? v : 1;
  }
  return mapZoom;
}

/* 마인드맵.

   가운데에 이 판이 있고, 같은 말이 든 조각끼리 한 가지로 뻗어 나간다.
   세로 목록으로 그리면 지도가 아니라 묶어 놓은 목록이 된다. 지도의 값은 위치와 선에
   있어서, 어느 조각이 두 가지에 걸쳐 있는지를 목록에서는 세어야 알고 지도에서는 바로 보인다.

   여기서 정하는 것은 각도까지이고 반지름은 layoutMap 이 정한다. 겹침 여부는 실제 칸
   크기가 있어야 알 수 있고, 그 크기는 DOM 에 올린 뒤에 나온다. */
/* 가지 고치기.

   자동으로 뽑은 것은 후보다. 사람이 이름을 바꾸고, 필요 없는 말을 빼고, 같은 뜻으로 갈린
   말을 합치고, 한 장뿐인 말을 남길 수 있어야 한다. 고친 것은 단어에 남아서 조각이
 늘어도 재계산이 되돌리지 않는다.

   고친 것은 전부 되돌릴 수 있게 화면에 남긴다. 뺀 말이 보이지 않으면 그 판단이
   맞았는지 다시 확인할 수 없다. */
function wordSet(b, patch) {
  Store.cfg(b.id, 'word', patch);
  render();
}

function wordEdit(b, hubs) {
  const cf = wordCfg(b);
  const h = hubs.find((x) => x.key === wordPick);
  const rows = [];

  if (h) {
    const base = h.words[0];
    const pinned = h.words.some((w) => cf.keep.has(w));
    const inp = el('input', {
      class: 'wname', type: 'text', value: h.word, placeholder: '가지 이름',
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    });
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      const name = { ...cf.name };
      if (v && v !== h.words.join(' · ')) name[base] = v; else delete name[base];
      wordSet(b, { name });
    });

    const pick = el('select', { class: 'wmerge' },
      el('option', { value: '' }, '합칠 가지 고르기'),
      hubs.filter((x) => x.key !== h.key).map((x) => el('option', { value: x.words[0] }, x.word)));
    pick.addEventListener('change', () => {
      if (!pick.value) return;
      const to = { ...cf.to };
      h.words.forEach((w) => { to[w] = pick.value; });
      h.raws.forEach((w) => { to[w] = pick.value; });
      wordPick = null;
      wordSet(b, { to });
    });

    rows.push(el('div', { class: 'werow' },
      el('span', { class: 'wcap' }, '고른 가지'),
      inp,
      pick,
      el('button', {
        class: 'ghost', title: pinned ? '한 장이 되면 사라지게' : '한 장뿐이어도 세워 두기',
        onclick: () => {
          const keep = new Set(cf.keep);
          h.words.forEach((w) => (pinned ? keep.delete(w) : keep.add(w)));
          wordSet(b, { keep: [...keep] });
        },
      }, pinned ? '고정 풀기' : '고정'),
      el('button', {
        class: 'ghost', title: '이 말로는 묶지 않기',
        onclick: () => {
          const drop = [...new Set([...cf.drop, ...h.raws])];
          wordPick = null;
          wordSet(b, { drop });
        },
      }, '빼기')));
  }

  const fixed = [];
  [...cf.drop].forEach((w) => fixed.push(['뺀 말', w, () => {
    wordSet(b, { drop: [...cf.drop].filter((x) => x !== w) });
  }]));
  Object.entries(cf.to).forEach(([from, to]) => fixed.push(['합친 말', `${from} → ${to}`, () => {
    const next = { ...cf.to };
    delete next[from];
    wordSet(b, { to: next });
  }]));
  Object.entries(cf.name).forEach(([w, v]) => fixed.push(['붙인 이름', `${w} → ${v}`, () => {
    const next = { ...cf.name };
    delete next[w];
    wordSet(b, { name: next });
  }]));

  if (fixed.length) {
    rows.push(el('div', { class: 'werow fixed' },
      el('span', { class: 'wcap' }, `고친 것 ${fixed.length}`),
      fixed.map(([kind, txt, undo]) => el('button', {
        class: 'wchip', title: '되돌리기', onclick: undo,
      }, el('b', {}, kind), txt, el('span', { class: 'x' }, '×')))));
  }

  return rows.length ? el('div', { class: 'wordedit' }, rows) : null;
}

function viewWord(b, stage) {
  const { hubs, alone, count } = wordMap(b);
  const byId = Object.fromEntries(b.pieces.map((p) => [p.id, p]));

  const hint = el('div', { class: 'wordhint' },
    el('b', {}, '같은 말이 든 것끼리'),
    el('span', {}, hubs.length ? `가지 ${hubs.length} · 안 묶인 것 ${alone.length}`
      : '두 장 이상에 같이 나오는 말이 아직 없음'));
  stage.append(hint);

  const fixer = wordEdit(b, hubs);
  if (fixer) stage.append(fixer);

  if (!hubs.length) {
    stage.append(el('div', { class: 'empty' }, b.pieces.length
      ? '같은 말이 두 번 나오면 여기에 가지 하나.'
      : '조각을 몇 줄 적으면 여기에 가지가 섬.'));
    if (alone.length) stage.append(wordFree(b, alone));
    return;
  }

  const wrap = el('div', { class: 'mapwrap' });
  const canvas = el('div', { class: 'mapcanvas' });
  // 배율은 canvas 를 scale 로 줄인다. 줄인 만큼 스크롤 영역도 줄어야 해서 크기를 가진 바깥 요소를 둔다
  const sizer = el('div', { class: 'mapsizer' }, canvas);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mapsvg');
  canvas.append(svg);

  // 가운데는 이 판이다. 이름이 없으면 비워 두지 않고 무엇을 보는 중인지 적는다
  const core = el('div', { class: 'mnode core' }, b.title || '이 판');
  canvas.append(core);

  /* 가지마다 한 조각씩 나눠 갖는다. 여러 가지에 걸친 조각은 해당 가지들의 가운데에 두고
     선을 모두 긋는다. 그 지점이 주제가 겹치는 곳이다. */
  const homeOf = new Map();
  hubs.forEach((h, hi) => h.ids.forEach((id) => {
    if (!homeOf.has(id)) homeOf.set(id, []);
    homeOf.get(id).push(hi);
  }));

  const total = hubs.reduce((n, h) => n + Math.max(1, h.ids.length), 0);
  const hubAt = [];
  let acc = -Math.PI / 2;
  hubs.forEach((h) => {
    const span = (Math.max(1, h.ids.length) / total) * Math.PI * 2;
    hubAt.push({ a0: acc, a1: acc + span, mid: acc + span / 2 });
    acc += span;
  });

  const spots = [];
  const hubEl = [];
  const leafEl = new Map();
  // 각도만 가지고 DOM 에 올린다. 위치는 layoutMap 이 측정한 뒤에 정한다
  const drop = (node) => { node.style.left = '0px'; node.style.top = '0px'; canvas.append(node); };

  hubs.forEach((h, hi) => {
    const node = el('button', {
      class: 'mnode hub', title: '이 말이 든 조각만 남기기',
      onclick: () => { wordPick = wordPick === h.key ? null : h.key; render(); },
    }, el('span', { class: 'w' }, h.word), el('span', { class: 'n' }, String(h.ids.length)));
    if (wordPick === h.key) node.classList.add('on');
    else if (wordPick) node.classList.add('dim');
    drop(node);
    hubEl.push(node);
    // 놓은 위치는 단어에 매단다. 이름을 바꿨다고 옮겨 둔 위치가 풀리면 안 된다
    spots.push({ node, a: hubAt[hi].mid, tier: 1, r: 0, key: `w:${h.key}` });
  });

  const seen = new Set();
  hubs.forEach((h, hi) => {
    const rows = h.ids.filter((id) => !seen.has(id));
    rows.forEach((id) => seen.add(id));
    rows.forEach((id, i) => {
      const mine = homeOf.get(id) || [hi];
      // 여러 가지에 걸친 것은 자기 가지들의 가운데 각도로. 한 가지짜리는 그 가지 부채꼴 안으로
      let a;
      if (mine.length > 1) {
        const xs = mine.reduce((t, k) => t + Math.cos(hubAt[k].mid), 0);
        const ys = mine.reduce((t, k) => t + Math.sin(hubAt[k].mid), 0);
        a = Math.atan2(ys, xs);
      } else {
        const { a0, a1 } = hubAt[hi];
        const pad = (a1 - a0) * 0.14;
        a = rows.length === 1 ? (a0 + a1) / 2
          : a0 + pad + ((a1 - a0 - pad * 2) * i) / (rows.length - 1);
      }
      const p = byId[id];
      const node = pieceNode(b, p, false);
      node.classList.add('mnode', 'leaf');
      if (mine.length > 1) node.classList.add('multi');
      if (wordPick && !mine.some((k) => hubs[k].key === wordPick)) node.classList.add('dim');
      const n = count.get(id) || 0;
      if (n > 1) {
        node.querySelector('.line').append(
          el('span', { class: 'xn', title: '이만큼의 가지에 함께 걸림' }, `＋${n - 1}`));
      }
      drop(node);
      leafEl.set(id, node);
      spots.push({ node, a, tier: 2, r: 0, key: id });
    });
  });

  wrap.append(sizer);
  stage.append(wrap);
  if (alone.length) stage.append(wordFree(b, alone));

  let baseW = 1;
  let baseH = 1;
  const zn = el('span', { class: 'zn' }, `${Math.round(zoomNow() * 100)}%`);

  function applyZoom(z, ax, ay) {
    const before = mapZoom;
    mapZoom = Math.min(MAP_Z_MAX, Math.max(MAP_Z_MIN, z));
    sizer.style.width = `${Math.round(baseW * mapZoom)}px`;
    sizer.style.height = `${Math.round(baseH * mapZoom)}px`;
    canvas.style.transform = `scale(${mapZoom})`;
    zn.textContent = `${Math.round(mapZoom * 100)}%`;
    // 잡고 있던 점이 같은 위치에 남도록 스크롤한다. 그러지 않으면 배율을 바꿀 때마다 보던 곳을 놓친다
    if (ax != null) {
      const k = mapZoom / before;
      wrap.scrollLeft = (wrap.scrollLeft + ax) * k - ax;
      wrap.scrollTop = (wrap.scrollTop + ay) * k - ay;
    }
  }
  // 사람이 바꾼 배율만 남긴다. 다시 그릴 때마다 적으면 저장이 계속 반복된다
  const setZoom = (z, ax, ay) => { applyZoom(z, ax, ay); Store.ui('mapZoom', mapZoom); };
  const step = (k) => setZoom(mapZoom * k, wrap.clientWidth / 2, wrap.clientHeight / 2);
  function fitAll() {
    setZoom(Math.min(1, (wrap.clientWidth - 16) / baseW, (wrap.clientHeight - 16) / baseH));
    wrap.scrollLeft = Math.max(0, (baseW * mapZoom - wrap.clientWidth) / 2);
    wrap.scrollTop = Math.max(0, (baseH * mapZoom - wrap.clientHeight) / 2);
  }

  const reset = el('button', {
    class: 'zb wide' + (Object.keys(b.map || {}).length ? '' : ' gone'),
    title: '직접 옮긴 곳을 다 버리고 계산에 맡기기',
    onclick: () => { Store.mapReset(b.id); render(); },
  }, '놓은 곳 비우기');

  // 단추는 안내 줄에 둔다. 지도 위에 띄우면 그 아래 조각을 가린다
  hint.append(el('div', { class: 'mapzoom' },
    el('button', { class: 'zb', title: '줄이기', onclick: () => step(1 / 1.25) }, '－'),
    zn,
    el('button', { class: 'zb', title: '키우기', onclick: () => step(1.25) }, '＋'),
    el('button', { class: 'zb wide', title: '전체가 한 화면에 들어오게', onclick: fitAll }, '맞춤'),
    reset));

  // ⌘·Ctrl 을 누른 채 스크롤하면 배율, 그냥 스크롤하면 지도를 이동한다. 나누지 않으면 이동할 방법이 없다
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    setZoom(mapZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  /* 지도 이동. 빈 곳을 잡고 끌면 이동하고, 조각 위에서는 ⌘·Ctrl 을 누른 채라야 이동한다.
     그러지 않으면 조각을 옮기려는 동작이 지도를 이동시킨다. 이동과 옮기기가 같은 동작이라
     무엇을 잡았는지와 무엇을 눌렀는지로 구분한다. */
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.mnode') && !(e.metaKey || e.ctrlKey)) return;
    if (e.target.closest('button, input, textarea, select') && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const l = wrap.scrollLeft;
    const t = wrap.scrollTop;
    wrap.classList.add('panning');
    try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* 캡처 안 되는 입력 */ }
    const mv = (m) => {
      wrap.scrollLeft = l - (m.clientX - sx);
      wrap.scrollTop = t - (m.clientY - sy);
    };
    const up = () => {
      wrap.removeEventListener('pointermove', mv);
      wrap.removeEventListener('pointerup', up);
      wrap.removeEventListener('pointercancel', up);
      wrap.classList.remove('panning');
    };
    wrap.addEventListener('pointermove', mv);
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', up);
  });

  let paint = null;     // layoutMap 이 준 선 다시 긋기
  let shift = { x: 0, y: 0 };

  function relayout() {
    const sl = wrap.scrollLeft;
    const st = wrap.scrollTop;
    const was = shift;
    const box = layoutMap(b, canvas, core, spots, hubEl, leafEl, homeOf, svg);
    paint = box.paint;
    shift = { x: box.ox, y: box.oy };
    baseW = box.w;
    baseH = box.h;
    applyZoom(mapZoom);
    // 캔버스가 커지면 지도 전체가 이동한다. 보고 있던 곳이 유지되도록 그만큼 되돌린다
    wrap.scrollLeft = sl + (shift.x - was.x) * mapZoom;
    wrap.scrollTop = st + (shift.y - was.y) * mapZoom;
  }

  /* 조각·가지를 직접 옮긴다.

     4px 을 넘게 움직였을 때만 옮기기로 본다. 그 아래는 클릭이다. 조각을 누르면
     고치기가 열리고 가지를 누르면 걸러지므로, 옮기기가 그 둘을 가로채면 안 된다.
     옮긴 뒤에는 그 클릭 한 번을 무시한다. 그러지 않으면 놓는 순간 고치기가 열린다. */
  const mapDrag = (node, key) => {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
      if (e.target.closest('button, input, textarea, select')) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const l0 = parseFloat(node.style.left) || 0;
      const t0 = parseFloat(node.style.top) || 0;
      let moved = false;
      try { node.setPointerCapture(e.pointerId); } catch (err) { /* 캡처 안 되는 입력 */ }
      const mv = (m) => {
        const dx = (m.clientX - sx) / mapZoom;
        const dy = (m.clientY - sy) / mapZoom;
        if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
        if (!moved) { moved = true; node.classList.add('moving'); }
        node.style.left = `${Math.round(l0 + dx)}px`;
        node.style.top = `${Math.round(t0 + dy)}px`;
        if (paint) paint();
      };
      const up = () => {
        node.removeEventListener('pointermove', mv);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
        node.classList.remove('moving');
        if (!moved) return;
        node.addEventListener('click', (c) => { c.stopPropagation(); c.preventDefault(); },
          { capture: true, once: true });
        Store.mapAt(b.id, key, {
          x: (parseFloat(node.style.left) || 0) - (parseFloat(core.style.left) || 0),
          y: (parseFloat(node.style.top) || 0) - (parseFloat(core.style.top) || 0),
        });
        reset.classList.remove('gone');
        relayout();
      };
      node.addEventListener('pointermove', mv);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });
  };
  spots.forEach((sp) => mapDrag(sp.node, sp.key));

  // 선은 배치가 끝난 뒤에 얹는다. 측정 전에 그으면 글자 길이가 반영되지 않는다
  requestAnimationFrame(() => {
    relayout();
    applyZoom(zoomNow());
    // 처음에는 가운데가 보이게 둔다
    wrap.scrollLeft = Math.max(0, core.offsetLeft * mapZoom - wrap.clientWidth / 2);
    wrap.scrollTop = Math.max(0, core.offsetTop * mapZoom - wrap.clientHeight / 2);
  });
}

/* 아직 묶이지 않은 것은 지도 밖에 둔다. 선이 하나도 없는 점을 지도에 찍으면
   묶인 것과 구별되지 않고, 이 줄이 짧아지는 것이 진행 상황을 나타낸다. */
function wordFree(b, alone) {
  return el('div', { class: 'wordfree' },
    el('div', { class: 'cap' }, `아직 안 묶인 것 ${alone.length}`),
    el('div', { class: 'leaves' }, alone.map((p) => {
      const node = pieceNode(b, p, false);
      node.classList.add('wleaf');
      return node;
    })));
}

/* 반지름을 정하고, 겹친 것을 떼고, 캔버스 크기를 맞추고, 선을 얹는다.

   각도는 viewWord 가 정한다. 반지름을 여기서 정하는 것은 그것이 겹침 문제이기 때문이다.
   178·330 으로 고정해 그리면 조각이 늘수록 서로 겹치고 넓어질 방법이 없으므로,
   겹치는 부분이 많을수록 간격을 늘린다.

   네 단계다.
     1 가지 고리   안쪽 겹부터 각도가 비는 곳에 넣고, 빈 곳이 없으면 한 겹 바깥으로
     2 조각 고리   같은 규칙으로, 가장 바깥 가지보다 밖에서 시작해서
     3 남은 겹침   글자 줄 수가 달라 높이가 제각각이라 1·2 로 다 풀리지 않는다. 겹친 짝을
                   서로 밀어 뗀다. 가운데는 움직이지 않고 가지는 조금만 움직인다
     4 캔버스 크기 가운데를 0,0 으로 계산하므로 왼쪽·위로 음수가 나온다. 그만큼 밀어 넣는다

   사람이 직접 옮겨 둔 것(b.map)은 1·2 를 건너뛰고 그 위치에 그대로 두며, 3 에서도
   움직이지 않는다. 계산이 사람의 배치를 되돌리면 직접 옮기는 동작이 성립하지 않는다.

   돌려주는 것은 canvas 의 크기와 밀어 넣은 양, 그리고 선을 다시 긋는 함수다. 지도 안에서
   조각을 끌 때 배치를 다시 계산하지 않고 선만 따라오게 하려면 그 함수가 밖에 있어야 한다. */
function layoutMap(b, canvas, core, spots, hubEl, leafEl, homeOf, svg) {
  const GAP = 18;
  const R1_MIN = 150;
  const R_MAX = 4000;    // 이보다 밖으로는 안 민다. 남는 겹침은 3 단계가 뗀다
  const RINGS_MAX = 40;

  const sz = new Map();
  sz.set(core, { w: core.offsetWidth, h: core.offsetHeight });
  spots.forEach((s) => sz.set(s.node, { w: s.node.offsetWidth, h: s.node.offsetHeight }));

  const norm = (a) => { const x = a % (Math.PI * 2); return x < 0 ? x + Math.PI * 2 : x; };
  // 반지름 R 에서 need 만큼 벌어지려면 몇 라디안이 필요한가
  const angFor = (R, need) => (need >= 2 * R ? Math.PI : 2 * Math.asin(need / (2 * R)));

  const hubs = spots.filter((s) => s.tier === 1);
  const leaves = spots.filter((s) => s.tier === 2);
  const coreSz = sz.get(core);

  /* 한 고리에 다 담기지 않으면 한 겹 바깥으로 보낸다. 가지와 조각이 같은 규칙을 쓴다.

     가지를 고리 하나에만 두고 이웃끼리 겹치지 않을 때까지 반지름을 넓히면, 각도가 매단
     조각 수에 비례하므로 조각 하나짜리 가지의 각도가 좁아 반지름이 크게 늘어난다
     (확인 결과: 가지 32 개에서 반지름 1400, 캔버스 4134 x 3529). 겹으로 쌓으면 절반이 된다. */
  const fillRings = (items, Rstart, step) => {
    const rings = [];
    const tall = [];
    items.slice().sort((x, y) => norm(x.a) - norm(y.a)).forEach((s) => {
      const a = norm(s.a);
      const z = sz.get(s.node);
      for (let k = 0; ; k += 1) {
        // 배치를 고를 때 쓰는 근사 반지름. 실제 반지름은 겹이 다 찬 뒤에 정한다
        const R = Math.min(Rstart + k * step, R_MAX);
        if (!rings[k]) rings[k] = [];
        const half = angFor(R, z.w / 2 + GAP / 2);
        const clash = rings[k].some((o) => {
          const d = Math.abs(a - o.a);
          return Math.min(d, Math.PI * 2 - d) < half + o.half;
        });
        if (!clash || k >= RINGS_MAX) {
          rings[k].push({ a, half });
          s.k = k;
          tall[k] = Math.max(tall[k] || 0, z.h);
          break;
        }
      }
    });
    /* 겹 사이는 그 겹에서 가장 키 큰 것만큼만 벌린다. 판 전체에서 가장 큰 카드 하나로
       모든 겹을 벌리면 짧은 카드만 있는 겹까지 그만큼 밀려 지도가 크게 남는다. */
    const at = [];
    for (let k = 0; k < rings.length; k += 1) {
      at[k] = k === 0 ? Rstart : at[k - 1] + (tall[k - 1] || 0) / 2 + (tall[k] || 0) / 2 + GAP;
    }
    items.forEach((s) => { s.r = Math.min(at[s.k] || Rstart, R_MAX); });
    return Math.min(at.length ? at[at.length - 1] : Rstart, R_MAX);
  };

  const hubH = hubs.length ? Math.max(...hubs.map((s) => sz.get(s.node).h)) : 0;
  const leafH = leaves.length ? Math.max(...leaves.map((s) => sz.get(s.node).h)) : 0;
  const widest = hubs.length ? Math.max(...hubs.map((s) => sz.get(s.node).w)) : 0;

  /* 1 가지 고리.

     시작 반지름을 가장 작게 잡으면 가지 마흔이 가운데에 겹겹이 쌓여 글자를 읽을 수 없다
 (확인 결과: 고리 여섯 겹). 가지들의 폭을 더해 두 겹에 담길
     둘레를 먼저 잡으면 가지가 고리 모양으로 배치되고 안쪽이 비어 가운데가 보인다. */
  const hubSpan = hubs.reduce((t, sp) => t + sz.get(sp.node).w + GAP, 0);
  const R1 = Math.max(R1_MIN, coreSz.w / 2 + widest / 2 + GAP, hubSpan / (Math.PI * 4));
  const hubFar = fillRings(hubs, R1, hubH + GAP);

  // 2 조각 고리. 가장 바깥 가지보다 밖에서 시작한다
  fillRings(leaves, hubFar + hubH / 2 + leafH / 2 + GAP, leafH + GAP);

  // 3 남은 겹침. 겹친 짝을 서로 민다
  const at = new Map();
  at.set(core, { x: 0, y: 0, w: coreSz.w, h: coreSz.h, m: 0 });
  spots.forEach((s) => {
    const z = sz.get(s.node);
    const put = (b.map || {})[s.key];
    at.set(s.node, {
      x: put ? put.x : Math.cos(s.a) * s.r,
      y: put ? put.y : Math.sin(s.a) * s.r,
      w: z.w,
      h: z.h,
      // 가운데와 사람이 옮긴 것은 안 움직이고 가지는 조금만. 가지가 자유롭게 움직이면 부채꼴이 무너진다
      m: put ? 0 : (s.tier === 1 ? 0.4 : 1),
    });
  });
  const list = [...at.values()];
  for (let pass = 0; pass < 60; pass += 1) {
    let hit = 0;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const A = list[i];
        const B = list[j];
        const ox = (A.w + B.w) / 2 + GAP - Math.abs(A.x - B.x);
        if (ox <= 0) continue;
        const oy = (A.h + B.h) / 2 + GAP - Math.abs(A.y - B.y);
        if (oy <= 0) continue;
        const sum = A.m + B.m;
        if (!sum) continue;
        // 덜 겹친 축으로 뗀다. 많이 겹친 축으로 밀면 다른 것을 넘어가게 된다
        if (ox < oy) {
          const d = (A.x <= B.x ? -1 : 1) * ox;
          A.x += (d * A.m) / sum;
          B.x -= (d * B.m) / sum;
        } else {
          const d = (A.y <= B.y ? -1 : 1) * oy;
          A.y += (d * A.m) / sum;
          B.y -= (d * B.m) / sum;
        }
        hit += 1;
      }
    }
    if (!hit) break;
  }

  // 4 캔버스 크기
  const PAD = 24;
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  at.forEach((r) => {
    minX = Math.min(minX, r.x - r.w / 2); maxX = Math.max(maxX, r.x + r.w / 2);
    minY = Math.min(minY, r.y - r.h / 2); maxY = Math.max(maxY, r.y + r.h / 2);
  });
  const ox = PAD - minX;
  const oy = PAD - minY;
  const W = Math.round(maxX - minX + PAD * 2);
  const H = Math.round(maxY - minY + PAD * 2);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  at.forEach((r, n) => {
    r.x += ox;
    r.y += oy;
    n.style.left = `${Math.round(r.x)}px`;
    n.style.top = `${Math.round(r.y)}px`;
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));

  /* 선은 계산해 둔 값이 아니라 현재 배치된 위치에서 다시 읽는다. 그래야 조각을 끄는
     동안에도 선이 따라온다. 계산값을 쓰면 놓을 때까지 선이 제자리에 남는다. */
  const spot = (n) => ({ x: parseFloat(n.style.left) || 0, y: parseFloat(n.style.top) || 0 });
  const paint = () => {
    svg.innerHTML = '';
    const path = (a, z, cls) => {
      const A = spot(a);
      const Z = spot(z);
      const mx = (A.x + Z.x) / 2;
      const my = (A.y + Z.y) / 2;
      const n = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      n.setAttribute('class', cls);
      n.setAttribute('fill', 'none');
      n.setAttribute('d', `M ${A.x} ${A.y} Q ${mx} ${my} ${Z.x} ${Z.y}`);
      svg.append(n);
    };
    hubEl.forEach((h) => path(core, h, 'mln trunk'));
    leafEl.forEach((node, id) => {
      (homeOf.get(id) || []).forEach((hi) => {
        if (hubEl[hi]) path(hubEl[hi], node, 'mln' + ((homeOf.get(id) || []).length > 1 ? ' cross' : ''));
      });
    });
  };
  paint();

  return { w: W, h: H, ox, oy, paint };
}

const DRAW = {
  group: viewGroup, quad: viewQuad, todo: viewTodo, flow: viewFlow,
  tree: viewTree, prep: viewPrep, study: viewStudy, meet: viewMeet, link: viewLink,
  word: viewWord,
};

/* ---------- 마크다운 ---------- */

function toMarkdown(b) {
  const s = Store.slots(b, b.frame);
  // 여러 줄짜리 조각은 목록 안에서 이어 붙는다. 두 칸 들여써야 같은 항목으로 읽힌다
  const wrap = (t) => t.replace(/\n/g, '\n  ');
  const txt = (p) => wrap(b.star === p.id ? `**${p.text}**` : p.text);
  const inSlot = (k) => b.pieces.filter((p) => s[p.id] === k);
  const out = [`## ${b.title || '(제목 없음)'}`, ''];

  if (b.frame === 'group') {
    const groups = (b.cfg.group || {}).groups || [];
    groups.forEach((g, i) => {
      const rows = inSlot(g.k);
      if (!rows.length) return;
      out.push(`### ${g.n || '덩어리 ' + (i + 1)}`);
      rows.forEach((p) => out.push(`- ${txt(p)}`));
      out.push('');
    });
  } else if (b.frame === 'quad') {
    const c = b.cfg.quad || {};
    [['hh', `${c.xh || '오른쪽'} · ${c.yh || '위'}`], ['lh', `${c.xl || '왼쪽'} · ${c.yh || '위'}`],
     ['hl', `${c.xh || '오른쪽'} · ${c.yl || '아래'}`], ['ll', `${c.xl || '왼쪽'} · ${c.yl || '아래'}`]]
      .forEach(([k, label]) => {
        const rows = inSlot(k);
        if (!rows.length) return;
        out.push(`### ${label}`);
        rows.forEach((p) => out.push(`- ${txt(p)}`));
        out.push('');
      });
  } else if (b.frame === 'flow') {
    migrateFlow(b);
    const { stages, lanes } = flowCfg(b);
    const multi = lanes.length > 1;
    lanes.forEach((ln, li) => {
      const used = stages.some((_, i) => inSlot(flowKey(i, ln.k)).length);
      if (!used) return;
      if (multi) out.push(`### ${ln.n || '줄 ' + (li + 1)}`);
      stages.forEach((name, i) => {
        const rows = inSlot(flowKey(i, ln.k));
        if (!rows.length) return;
        const head = `${i + 1}. ${name || ''}`.trim();
        out.push(multi ? `**${head}**` : `### ${head}`);
        rows.forEach((p) => out.push(`- ${txt(p)}`));
        out.push('');
      });
    });
  } else if (b.frame === 'todo') {
    const cfg = b.cfg.todo || {};
    const view = cfg.view || 'all';
    const only = (p) => view === 'all' || p.cat === view;
    const star = b.pieces.find((x) => x.id === b.star);
    if (view !== 'all') out.push(`분류: ${catName(b, view)}`);
    if (star) out.push(`지금: ${star.text}`);
    if (view !== 'all' || star) out.push('');
    TODO_SLOTS.forEach(([k, label]) => {
      const rows = inSlot(k).filter(only).sort(byPlan(b, 'todo'));
      if (!rows.length) return;
      out.push(`### ${label}`);
      rows.forEach((p) => {
        const bits = [];
        if (view === 'all' && p.cat) bits.push(`(${catName(b, p.cat)})`);
        if (p.due) bits.push(p.due.slice(5));
        if (p.mins) bits.push(humanMin(p.mins));
        bits.push(txt(p));
        out.push(`- [${k === 'done' ? 'x' : ' '}] ${bits.join(' · ')}`);
      });
      out.push('');
    });
  } else if (b.frame === 'prep') {
    const c = b.cfg.prep || {};
    const goalName = (PREP_GOALS.find(([k]) => k === c.goal) || [null, null])[1];
    const head = [goalName ? `목적: ${goalName}` : null, c.mins ? `${c.mins}분` : null]
      .filter(Boolean).join(' · ');
    if (head) { out.push(head, ''); }
    const ask = PREP_ASK[c.goal && PREP_ASK[c.goal] ? c.goal : 'none'];
    PREP_SLOTS.forEach((k) => {
      const rows = inSlot(k);
      if (!rows.length) return;
      out.push(`### ${ask[k][0]}`);
      // 꺼낼 것은 순서가 곧 아젠다 순서다
      rows.forEach((p, i) => out.push(k === 'say' ? `${i + 1}. ${txt(p)}` : `- ${txt(p)}`));
      out.push('');
    });
  } else if (b.frame === 'study') {
    const c = b.cfg.study || {};
    if (c.src) out.push(`출처: ${c.src}`);
    if (c.sum) out.push(`한 줄: ${c.sum}`);
    if (c.src || c.sum) out.push('');
    const lines = c.lines || {};
    const locs = studyLocs(b).filter((x) => (lines[x.loc] || '').trim());
    if (locs.length) {
      out.push('### 흐름');
      locs.forEach((x) => out.push(`- ${x.loc}  ${lines[x.loc]}`));
      out.push('');
    }
    STUDY_SLOTS.forEach(([k, label]) => {
      const rows = inSlot(k);
      if (!rows.length) return;
      out.push(`### ${label}`);
      rows.forEach((p) => out.push(`- ${p.loc ? `[${p.loc}] ` : ''}${txt(p)}`));
      out.push('');
    });
  } else if (b.frame === 'meet') {
    const c = b.cfg.meet || {};
    if (c.who) out.push(`참석: ${c.who}`, '');
    MEET_SLOTS.forEach(([k, label]) => {
      const rows = inSlot(k);
      if (!rows.length) return;
      out.push(`### ${label}`);
      rows.forEach((p) => {
        if (k === 'heard' || k === 'ask') {
          out.push(`- ${txt(p)}${p.said ? ` (${p.said})` : ''}`);
          return;
        }
        if (k === 'decided') {
          out.push(`- ${txt(p)}${p.why ? ` (왜: ${p.why})` : ''}`);
          return;
        }
        const tail = [p.owner || '담당자 빈칸', p.due ? p.due.slice(5) : '기한 빈칸'].join(' · ');
        out.push(`- [ ] ${txt(p)} (${tail})`);
      });
      out.push('');
    });
    if (c.nextOn || c.next) {
      out.push('### 다음');
      out.push(`- ${[c.nextOn ? c.nextOn.slice(5) : null, c.next || null].filter(Boolean).join(' · ')}`);
      out.push('');
    }
  } else if (b.frame === 'link') {
    const { ls, cols } = linkLayout(b);
    const nm = (id) => (b.pieces.find((x) => x.id === id) || {}).text || '?';
    if (cols.length) {
      out.push('### 이음');
      // 층 순서대로 적는다. 읽는 사람이 원인부터 본다
      cols.forEach((col, i) => {
        col.forEach((id) => {
          const outs = ls.filter((l) => l.a === id);
          if (!outs.length && i) return;
          if (!outs.length) { out.push(`- ${nm(id)}`); return; }
          outs.forEach((l) => out.push(`- ${nm(l.a)} → ${nm(l.z)}  (${linkName(b, l.k)})`));
        });
      });
      out.push('');
    }
  } else if (b.frame === 'tree') {
    const walk = (parent, depth) => {
      b.pieces.filter((p) => s[p.id] === parent).forEach((p) => {
        out.push(`${'  '.repeat(depth)}- ${txt(p)}`);
        walk(p.id, depth + 1);
      });
    };
    walk('root', 0);
    out.push('');
  }

  const left = b.frame === 'link'
    ? linkLayout(b).free.map((id) => b.pieces.find((x) => x.id === id)).filter(Boolean)
    : b.pieces.filter((p) => !s[p.id]);
  if (left.length) {
    out.push(b.frame === 'link' ? '### 아직 안 이은 것' : '### 더미');
    left.forEach((p) => out.push(`- ${p.text.replace(/\n/g, '\n  ')}`));
  }
  return out.join('\n');
}

/* ---------- 겉면 ---------- */

// 접힌 레일에서 판을 가리키는 짧은 이름. 앞 두 글자면 대개 구분된다
function railShort(b) {
  const t = (b.title || (b.id === Store.INBOX ? '보관함' : '?')).trim();
  return t.slice(0, 2) || '?';
}

/* ---------- 판 끌기와 차림표 ----------

   조각 끌기와 판 끌기는 서로 다른 채널이다. 하나로 합치면 판을 끄는 동안 화면의 칸이
   전부 조각 놓는 영역이 되어 그 위에 판을 떨어뜨리게 된다. 그래서 변수도 body 표시도
   따로 둔다. 조각은 dragging + body.dragging, 판은 dragBoard + body.moving-board. */

let dragBoard = null;
// 지금 이름을 고치는 중인 폴더. 새 폴더를 만든 직후에도 여기 담긴다
let renameAt = null;

function boardDrag(node, boardId) {
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', (e) => {
    dragBoard = boardId;
    document.body.classList.add('moving-board');
    try { e.dataTransfer.setData('text/plain', boardId); } catch (err) { /* 일부 브라우저 */ }
    e.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => {
    dragBoard = null;
    document.body.classList.remove('moving-board');
    document.querySelectorAll('.board-over').forEach((n) => n.classList.remove('board-over'));
  });
  return node;
}

function boardDrop(node, onDrop, canDrop) {
  const ok = () => !!dragBoard && (!canDrop || canDrop(dragBoard));
  node.addEventListener('dragenter', (e) => { if (ok()) { e.preventDefault(); e.stopPropagation(); } });
  node.addEventListener('dragover', (e) => {
    if (!ok()) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('board-over');
  });
  node.addEventListener('dragleave', (e) => {
    if (node.contains(e.relatedTarget)) return;
    node.classList.remove('board-over');
  });
  node.addEventListener('drop', (e) => {
    if (!ok()) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragBoard;
    node.classList.remove('board-over');
    dragBoard = null;
    document.body.classList.remove('moving-board');
    onDrop(id);
  });
  return node;
}

// 겹쳐서 만드는 폴더의 첫 이름. 규칙은 group.js 가 소유한다. 여기서 다시 만들면 둘이 달라진다
const freshFolder = () => mergeFolder('', Store.folders()).name;

/* 판 하나를 다른 판 위에 놓았을 때.

   받는 판에 폴더가 있으면 끈 판이 그 폴더로 들어간다. 둘 다 없으면 새 폴더를 만들어
   둘을 넣고 그 머리를 곧바로 이름 편집 상태로 연다. 이름은 나중에 짓더라도 입력할
   자리는 그 순간 열어 둔다. */
function mergeBoards(dragId, dropId) {
  if (dragId === dropId) return;
  const drop = Store.boards().find((b) => b.id === dropId);
  if (!drop) return;
  const { name, fresh } = mergeFolder(drop.folder, Store.folders());
  if (fresh) Store.setFolder(dropId, name);
  Store.setFolder(dragId, name);
  // 새로 생긴 폴더만 이름 고치는 자리를 연다. 이미 있던 폴더에 넣은 것은 이름이 정해져 있다
  if (fresh) renameAt = name;
  render();
}

/* 우클릭 차림표.

   우클릭이 확인 없이 삭제만 실행하면 실수로 눌렀을 때 되돌릴 수 없고 폴더를 만들 수단도
   없다. 그래서 항목을 골라 누르는 차림표로 둔다. 한 번에 하나만 뜬다. */
function menuAt(e, items) {
  document.querySelectorAll('.railmenu').forEach((n) => n.remove());
  const box = el('div', { class: 'railmenu' },
    ...items.map(([name, run, danger]) => el('button', {
      class: 'mi' + (danger ? ' danger' : ''),
      onclick: () => { box.remove(); run(); },
    }, name)));
  document.body.append(box);
  // 화면 밖으로 넘치면 안쪽으로 당긴다. 넘친 부분은 누를 수 없다
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  box.style.left = `${Math.min(e.clientX, window.innerWidth - w - 8)}px`;
  box.style.top = `${Math.min(e.clientY, window.innerHeight - h - 8)}px`;
  const close = (ev) => {
    if (box.contains(ev.target)) return;
    box.remove();
    document.removeEventListener('pointerdown', close, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}

/* 판을 묶어 보는 두 방식.

   판이 일곱을 넘으면 평평한 목록에서는 이름을 하나씩 읽어야 찾을 수 있다. 묶는 축은
   둘이고 성격이 다르다. 폴더는 사람이 정하는 것이고(같은 일에 속한 판), 날짜는 자동으로
   생기는 것이다. 한 번에 하나로만 묶는다. 둘을 겹쳐 두 단으로 쌓으면 판 일곱에 머리가
   아홉이 된다.

   고른 축과 접힘은 창 상태에 담는다. 보는 사람의 화면 상태이지 판의 내용이 아니다. */
const railBy = () => (Store.ui('railBy') === 'date' ? 'date' : 'folder');

const groupShut = (key) => !!(Store.ui('groupShut') || {})[key];
function groupShutSet(key, on) {
  const map = { ...(Store.ui('groupShut') || {}) };
  if (on) map[key] = 1; else delete map[key];
  Store.ui('groupShut', map);
  render();
}

/* 묶음 머리. 접으면 그 묶음의 판이 표시되지 않는다.

   접힌 채로 그 안의 판을 열어 두면 지금 보고 있는 것이 목록 어디에도 없게 된다.
   그래서 지금 판이 든 묶음은 접혀 있어도 그 판 한 줄은 남긴다.

   감추는 것은 CSS 가 한다. 여기서 아예 그리지 않으면 줄을 접었을 때(56px, 머리도 축도
   내려간다) 펼 머리가 화면에 없어 그 판에 접근할 수 없다. 그려 두고 감추면 CSS 규칙
   하나만 바꾸면 된다. */
function railHead(key, label, count, folder) {
  const shut = groupShut(key);
  const named = !!folder;
  const head = el('div', { class: 'railgrp' + (shut ? ' shut' : '') },
    el('button', {
      class: 'twist', title: shut ? '펼치기' : '접기',
      onclick: () => groupShutSet(key, !shut),
    }, shut ? '▸' : '▾'),
    renameAt === folder && named
      // 이름을 고치는 중. 비운 채 나가면 그 폴더가 풀린다
      ? el('input', {
          class: 'gname edit', value: folder,
          /* Escape 로 나간 값은 저장하지 않는다. 칸을 지우는 순간 blur 가 뒤따르는
             브라우저가 있어서, 취소 표시를 칸에 남겨 두고 blur 가 그것을 확인한다.
             그러지 않으면 취소하려던 이름이 저장된다. */
          onblur: (e) => {
            renameAt = null;
            if (e.target.dataset.undo !== '1') Store.renameFolder(folder, e.target.value);
            render();
          },
          onkeydown: (e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') { e.target.dataset.undo = '1'; renameAt = null; render(); }
          },
        })
      /* 이름을 눌러도 접힌다. 손잡이 하나만 두면 삼각형 12px 을 정확히 눌러야 접히고,
         이름은 눌러도 반응이 없어 고장으로 보인다.
         이름 고치기는 우클릭 차림표가 담당한다. 한 곳에 두 동작을 겹치지 않는다. */
      : el('span', {
          class: 'gname', title: shut ? '펼치기' : '접기',
          onclick: () => groupShutSet(key, !shut),
        }, label),
    el('span', { class: 'gn' }, String(count)));

  if (renameAt === folder && named) {
    // 새로 만든 폴더는 곧바로 이름 편집 상태로 연다. 이름 없이 남으면 「새 폴더」가 쌓인다
    setTimeout(() => { const i = head.querySelector('.gname.edit'); if (i) { i.focus(); i.select(); } }, 0);
  }

  // 폴더 머리 위에 판을 놓으면 그 폴더로 들어간다. 「폴더 없음」 머리는 폴더에서 빼내는 영역이다
  if (key.startsWith('folder|')) {
    boardDrop(head, (id) => { Store.setFolder(id, folder); render(); });
    head.addEventListener('contextmenu', (e) => {
      if (!named) return;
      e.preventDefault();
      menuAt(e, [
        ['폴더 이름 바꾸기', () => { renameAt = folder; render(); }],
        ['폴더 풀기', () => { Store.renameFolder(folder, ''); render(); }],
      ]);
    });
  }
  return head;
}

function renderRail() {
  const list = $('#board-list');
  list.innerHTML = '';
  const cur = Store.current();
  const by = railBy();

  // 축을 고르는 영역. 접은 줄에서는 이름이 두 글자뿐이라 이 영역도 같이 내려간다
  const pick = (mode, name) => el('button', {
    class: 'byb' + (by === mode ? ' on' : ''),
    onclick: () => { Store.ui('railBy', mode); render(); },
  }, name);
  list.append(el('div', { class: 'railby' }, pick('folder', '폴더'), pick('date', '날짜')));

  const node = (b) => {
    /* 판 이름 옆 개수는 보관함에만 둔다.

       모든 판에 「그 판의 지금 열린 탭에서 아직 안 놓인 조각 수」를 달면 탭을 바꿀 때마다
       값이 바뀐다. 공부 탭에서 다 배치한 판이 준비 탭으로 열려 있으면 "안 놓은 것 3"으로
       보여, 정리한 판이 정리되지 않은 것처럼 읽힌다. 탭마다 배치가 따로 남는 것이 이 판의
       설계이므로 판 하나에 그런 수는 성립하지 않는다.

       보관함은 다르다. 받아두는 곳이라 쌓인 조각 수가 아직 판으로 보내지 않은 양이고,
       그 값은 어느 탭을 열어 두든 바뀌지 않는다. */
    const waiting = b.id === Store.INBOX ? b.pieces.length : 0;
    const item = el('button', {
      class: 'board-item' + (b.id === cur.id ? ' on' : '') + (b.id === Store.INBOX ? ' inbox' : ''),
      title: b.title || (b.id === Store.INBOX ? '보관함' : '제목 없음'),
      onclick: () => { Store.open(b.id); picked = null; hereAt = null; render(); },
      oncontextmenu: (e) => {
        e.preventDefault();
        if (b.id === Store.INBOX) return;
        const name = b.title || '제목 없음';
        const items = [];
        if ((b.folder || '').trim()) {
          items.push(['폴더에서 빼기', () => { Store.setFolder(b.id, ''); render(); }]);
        } else {
          items.push(['폴더 만들기', () => {
            const made = freshFolder();
            Store.setFolder(b.id, made);
            renameAt = made;
            render();
          }]);
        }
        items.push(['판 삭제', () => {
          if (confirm(`"${name}" 판 삭제.`)) { Store.removeBoard(b.id); render(); }
        }, true]);
        menuAt(e, items);
      },
    },
      el('span', { class: 'full' }, b.title || (b.id === Store.INBOX ? '보관함' : '제목 없음')),
      // 접었을 때는 앞 두 글자만 남고, 전체 이름은 포인터를 올리면 표시된다
      el('span', { class: 'short' }, railShort(b)),
      // 조각을 집어 둔 동안에는 판 이름이 옮기는 대상이 된다.
      // 끌기만 두면 터치 환경에서는 옮길 방법이 없다.
      picked && b.id !== cur.id
        ? el('span', {
            class: 'mv', title: '집은 조각을 이 판으로',
            onclick: (e) => {
              e.stopPropagation();
              Store.movePieces(cur.id, b.id, [picked]);
              picked = null;
              render();
            },
          }, '→')
        : (waiting ? el('span', { class: 'n', title: '아직 판으로 안 보낸 것' }, String(waiting)) : null),
    );
    // 조각을 옆 판 이름 위로 끌어다 놓으면 그 판으로 옮겨간다.
    // 옮기는 순간 그 조각의 배치는 이전 판에서 지워진다. 칸은 판마다 다르기 때문이다.
    dropTarget(item, (id) => {
      Store.movePieces(Store.current().id, b.id, [id]);
      picked = null;
      render();
    }, () => b.id !== Store.current().id);
    /* 판끼리 겹치면 폴더가 된다. 보관함은 제외한다. 묶음 밖에 있는 항목이라
       거기로 끌어도, 거기에 놓아도 폴더가 성립하지 않는다. */
    if (b.id !== Store.INBOX) {
      boardDrag(item, b.id);
      boardDrop(item, (id) => mergeBoards(id, b.id), (id) => id !== b.id);
    }
    return item;
  };

  // 무엇을 어떻게 나눌지는 group.js 가 정한다. 여기는 그 결과를 세우기만 한다
  const { inbox, flat, groups } = railGroups(Store.boards(), by, Store.INBOX);
  if (inbox) list.append(node(inbox));

  if (flat) {
    flat.forEach((b) => list.append(node(b)));
    list.append(el('div', { class: 'railhint' },
      el('span', {}, '판끼리 겹치면 폴더'),
      el('span', {}, '오른쪽 클릭으로도 만들기')));
    return;
  }

  groups.forEach((g) => {
    // 묶음 키는 `축|값` 이다. 폴더 축일 때 그 값이 곧 폴더 이름이고, 날짜 축에는 없다
    const folder = g.key.startsWith('folder|') ? g.key.slice('folder|'.length) : '';
    list.append(railHead(g.key, g.label, g.rows.length, folder));
    const body = el('div', { class: 'railbody' + (groupShut(g.key) ? ' shut' : '') });
    g.rows.forEach((b) => body.append(node(b)));
    list.append(body);
  });
}

function renderTop(b) {
  const title = $('#board-title');
  if (document.activeElement !== title) title.value = b.title;
  title.placeholder = b.id === Store.INBOX ? '보관함' : '이 판은 무엇에 대한 것인가';
  title.disabled = b.id === Store.INBOX;

  /* 폴더는 여기서 정하지 않는다. 이름을 직접 입력해 만드는 칸은 두지 않는다.
     같은 폴더를 두 판에 적으려면 같은 문자열을 두 번 입력해야 하고, 한 글자만 달라도
     묶음이 둘로 갈리기 때문이다. 판을 판 위로 끌어 겹치거나 판 목록에서 우클릭한다. */

  const nav = $('#frames');
  nav.innerHTML = '';

  /* 탭은 한 줄이고 전부 한 번 누르면 된다.

     목적 여섯을 드롭다운에 넣고 모양(칸·줄·나무)을 앞에 세우면, 구현은 비슷해도 사용
     측면에서 회의와 공부는 다른 도구다. `회의`는 이름만으로 무엇을 하는지 알 수 있지만
     `칸`은 그렇지 않고, 한 번이면 되던 선택이 드롭다운을 열고 고르는 두 번이 된다.

     그래서 이름은 목적으로 두고, 나눈 축은 화면 뒤에 남긴다.
     앞의 여섯은 이 판이 무엇을 하는 것인지(칸 이름을 정한다), 뒤의 셋은 같은 조각을
     어떤 모양으로 볼지다. 뒤의 셋에 들어가도 앞의 어느 것이 켜져 있는지 옅게 남는다. */

  /* 끄는 동안에는 탭이 놓는 영역이다. 어느 칸으로 들어가는지는 탭 안에 적어 둔다.
     적지 않으면 어디로 갔는지 알 수 없어 사라진 것처럼 보인다. */
  /* 탭 줄은 놓는 영역이 아니다.

     탭을 놓는 영역으로 쓰면 탭 하나가 받을 수 있는 것은 그 프레임의 첫 칸 하나뿐이라
     「공부」에 놓으면 항상 「그대로」로 간다. 내 말로·의문·그래서 나는에는 넣을 수 없어
     놓는 영역과 실제로 넣을 수 있는 칸이 달라진다. 그래서 끄는 동안 판 위쪽이 갈라지고
     거기에 모든 칸이 선다(sendTray). */
  /* 탭 줄에 처음부터 보이는 것과, 「더」 뒤에 접히는 것.

     열 개를 항상 세우면 좁은 창에서 가로로 밀려 뒤쪽 넷이 보이지 않는다. 사용하지 않는
     항목을 항상 세우면 쓰는 항목을 고르는 데 그만큼 시간이 더 든다.

     지우지 않고 접는다. 그리고 다음 세 경우에 자동으로 펼쳐진다.
       이 판에 놓인 조각이 있는 분류
       지금 열려 있는 분류
       사람이 「더」를 누른 동안
     쓰기 시작하면 접히지 않으므로 이 기본값이 맞지 않아도 자동으로 조정된다. */
  const CORE = new Set(['group', 'todo', 'meet', 'study', 'word']);
  const used = (frame) => Object.keys((b.place || {})[frame] || {}).length > 0;
  const allTabs = !!Store.ui('allTabs');
  let folded = 0;
  const shows = (key, frame, isCur) => {
    if (CORE.has(key) || allTabs || isCur || used(frame)) return true;
    folded += 1;
    return false;
  };

  const tab = (name, on, cur, extra, onclick) =>
    el('button', { class: 'frame-tab' + (on ? ' on' : '') + (cur ? ' cur' : ''), onclick },
      extra, el('span', { class: 'nm' }, name));

  Object.entries(KINDS).forEach(([k, v]) => {
    if (!shows(k, k, b.kind === k)) return;
    nav.append(tab(v.name, b.view === 'box' && b.kind === k, b.view !== 'box' && b.kind === k,
      el('span', { class: 'tip' }, el('b', {}, v.name), el('span', { class: 'eg' }, v.line)),
      () => {
        if (b.kind !== k) Store.patchBoard(b.id, { kind: k });
        setView(Store.current(), 'box');
      }));
  });

  // 가름선은 뒤에 설 것이 있을 때만. 접혀서 아무것도 없으면 선만 남는다
  const seeViews = ['line', 'tree', 'link', 'word'].filter((k) => shows(k, FRAME_OF[k], b.view === k));
  if (seeViews.length) nav.append(el('div', { class: 'tabsplit' }));

  seeViews.forEach((k) => {
    const v = VIEWS[k];
    nav.append(tab(v.name, b.view === k, false,
      [svgArt(v.art), el('span', { class: 'tip' },
        el('b', {}, v.what), el('span', { class: 'eg' }, v.eg))],
      () => setView(b, k)));
  });

  /* 접힌 개수를 적어 둔다. 개수 없이 「더」만 있으면 뒤에 무엇이 있는지 알 수 없다.
     펼친 상태에서는 다시 접는 단추가 된다. 한 번 펴면 접을 수 없는 단추는 쓸 수 없다. */
  if (folded || allTabs) {
    nav.append(el('button', {
      class: 'frame-tab more' + (allTabs ? ' on' : ''),
      title: allTabs ? '안 쓰는 분류 접기' : '접어 둔 분류 펴기',
      onclick: () => { Store.ui('allTabs', !allTabs); render(); },
    }, el('span', { class: 'nm' }, allTabs ? '접기' : `더 ${folded}`)));
  }

  nav.append(el('div', { class: 'spacer' }));
  nav.append(el('div', { class: 'tools' },
    el('button', { class: 'ghost', title: '각 탭이 실제로 어떻게 보이는지', onclick: showGuide }, '예시'),
    el('button', { class: 'ghost', title: '이 판에서 쓰는 이름', onclick: showTerms }, '말뜻'),
    el('button', {
      class: 'ghost',
      onclick: () => { navigator.clipboard.writeText(toMarkdown(b)); say('판 전체 복사'); },
    }, '글로 복사'),
  ));

  /* 좁은 창에서는 탭 줄이 옆으로 밀린다. 지금 탭이 밀려 나간 채로 뜨면 위치를 알 수
     없으므로 그 탭이 보이는 위치로 스크롤한다. */
  const on = nav.querySelector('.frame-tab.on');
  if (on && nav.scrollWidth > nav.clientWidth) {
    const l = on.offsetLeft;
    const r = l + on.offsetWidth;
    if (l < nav.scrollLeft) nav.scrollLeft = Math.max(0, l - 12);
    else if (r > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = r - nav.clientWidth + 12;
  }
}

function svgArt(d) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  n.setAttribute('class', 'art');
  n.setAttribute('viewBox', '0 0 28 22');
  n.setAttribute('aria-hidden', 'true');
  n.innerHTML = d;
  return n;
}


function setView(b, view) {
  Store.patchBoard(b.id, { view, frame: frameOf({ ...b, view }) });
  picked = null;
  render();
}

/* 더미 칸 위의 「지금 여기」.

   한 번 적어 두면 그 뒤에 담는 조각에 자동으로 붙는다. 카드마다 적게 하면 적지 않게 된다.
   영상은 되감아야 하고 회의는 안건이 지나가므로, 그 시점에 기록하지 않으면 복원되지 않는다.

   아래 딱지 줄은 이 판에 실제로 있는 위치다. 누르면 그 위치의 것만 남는다.
   나무·이음은 칸을 쓰지 않아 거를 수 없으므로 딱지를 감춘다. */
function hereBar(b) {
  const t = tune(b);
  const box = el('div', { id: 'now-loc', class: 'nowloc' });

  const line = el('div', { class: 'nowline2' }, el('span', { class: 'lbl' }, t.here));
  const i = el('input', { type: 'text', value: b.at || '', placeholder: t.herePh });
  i.addEventListener('change', () => { Store.patchBoard(b.id, { at: i.value.trim() }); render(); });
  line.append(i);
  box.append(line);

  const locs = hereList(b);
  if (CAN_FILTER(b) && locs.length > 1) {
    const chips = el('div', { class: 'nowchips' },
      el('button', {
        class: 'lc' + (hereAt ? '' : ' on'),
        onclick: () => { hereAt = null; render(); },
      }, '전부'));
    locs.forEach((x) => chips.append(el('button', {
      class: 'lc' + (hereAt === x.loc ? ' on' : ''),
      title: '이 자리 것만 보기',
      onclick: () => { hereAt = hereAt === x.loc ? null : x.loc; render(); },
    }, x.loc, el('i', {}, String(x.n)))));
    box.append(chips);
  }
  return box;
}

function renderPile(b) {
  // 이음 보기에서 "놓았다"는 칸에 넣은 것이 아니라 어딘가에 이어 놓은 것이다.
  // 여기서 세는 값은 아직 잇지 않고 떨어져 있는 조각의 수다
  // 이음 보기에서는 조각이 전부 그림 안에 있다. 안 이은 것은 그림 맨 왼쪽 줄에 선다
  let left = [];
  if (b.view !== 'link') {
    const s = Store.slots(b, b.frame);
    left = b.pieces.filter((p) => !s[p.id]);
    if (hereAt) left = left.filter((p) => (p.loc || '').trim() === hereAt);
  }
  /* 「남은 것」이 아니다. 칸에 넣지 않은 조각도 기록으로 완결된 것이고, 그것을 처리할
 항목으로 세면 적는 것보다 분류하는 것이 일이 된다. 개수만 센다.*/
  $('#pile-count').textContent = b.view === 'link' ? '조각은 전부 그림에' : `더미 ${left.length}`;
  $('#pile-count').title = tip('더미');
  const list = $('#pile-list');
  list.innerHTML = '';
  if (!left.length) {
    list.append(el('div', { class: 'empty', style: 'color:#3f5a6b;font-size:12.5px' },
      b.pieces.length ? '전부 칸에 들어감. 안 넣어도 기록은 기록.' : '위 칸에 한 줄씩 적으면 여기로.'));
  } else {
    left.forEach((p) => list.append(pieceNode(b, p, false)));
  }
  // 인라인 style 로 켜면 좁은 창에서 숨기는 규칙보다 우선한다. 켜고 끄는 것은 class 로 한다
  $('#from-inbox').classList.toggle('gone', b.id === Store.INBOX);

  const oldHere = $('#now-loc');
  if (oldHere) oldHere.remove();
  $('#pile-list').before(hereBar(b));
  // 놓았던 것을 다시 끌어내면 더미로 돌아온다
  const pile = $('#pile');
  if (!pile.dataset.drop) {
    pile.dataset.drop = '1';
    // 이 핸들러는 한 번만 등록되므로 지금 판을 캡처하지 않고 떨어뜨리는 시점의 판을 읽는다
    dropTarget(pile, (id) => {
      const cur = Store.current();
      Store.put(cur.id, cur.frame, id, null);
      render();
    });
  }
}

/* 의문은 담기만 하고 끝난다.

   판 전체를 훑는 「물음 목록」 줄은 두지 않는다. 탭마다 의문 칸이 있으므로 같은 내용을
   두 번 표시하게 되고, 공부 탭에서는 「의문」이 두 개로 보인다.

   ✓ 로 닫는 단계도 두지 않는다. 담는 것으로 끝이고, 다시 볼 때는 그 칸을 연다.
   담을 때마다 나중에 정리할 일이 늘면 담는 것 자체를 하지 않게 된다. */

/* 가로로 배치하는 프레임.

   카드가 쌓이면 칸이 아래로 길어지고 판 전체가 세로로 늘어난다. 그러면 적으면서
   위아래를 오가야 하고 지금 칸에 무엇이 들었는지 한눈에 보이지 않는다.
   칸을 화면 높이에 맞추고 넘치면 옆으로 접어 가로로 늘어나게 한다.

   나눔은 제외한다. 네 칸의 위치가 곧 의미라 한 줄로 세우면 축이 사라진다.
   할 일도 제외한다. 오늘 띠가 시각 순서라 세로 방향 자체가 의미를 갖는다. */
const WIDE_FRAMES = new Set(['group', 'meet', 'prep', 'study']);

/* 다른 탭의 칸에 넣기.

   가장자리 스크롤은 지금 화면 안에서 스크롤해 닿는 칸만 해결한다. 다른 탭의 칸은
   그려져 있지 않아 스크롤로는 닿지 않고, 그 탭으로 이동해 다시 집어야 한다.
   끄는 동안에는 탭 줄이 놓는 영역이 된다. 놓으면 그 탭의 첫 칸으로 들어가고
   화면은 바뀌지 않는다. 어느 칸인지는 끄는 동안 탭에 표시된다.

   조각은 탭마다 따로 놓이므로 지금 탭의 배치는 그대로 남는다. 옮기는 것이 아니라
   그 탭에도 놓는 것이다. */
/* 한 프레임이 가진 칸 전부. 대표 하나가 아니라 전부다.

   대표 하나만 내주면 「공부」로 보낸 것이 항상 「그대로」로 들어간다. 보이지 않는 칸에
   넣으려면 어느 칸인지 고를 수 있어야 하는데, 선택지가 하나뿐이면 고르는 것이 아니다. */
function frameSlots(b, frame) {
  if (frame === 'quad') return Object.entries(QUAD_DO).map(([k, v]) => [k, v[0]]);
  if (frame === 'todo') return TODO_SLOTS.map(([k, n]) => [k, n]);
  if (frame === 'study') return STUDY_SLOTS.map(([k, n]) => [k, n]);
  if (frame === 'meet') return MEET_SLOTS.map(([k, n]) => [k, n]);
  if (frame === 'prep') {
    const ask = PREP_ASK[(b.cfg.prep || {}).goal || 'none'] || PREP_ASK.none;
    return PREP_SLOTS.map((k) => [k, (ask[k] || [])[0] || k]);
  }
  if (frame === 'group') {
    const gs = ((b.cfg.group || {}).groups) || GROUPS0;
    return gs.map((g, i) => [g.k, (g.n || '').trim() || `덩어리 ${i + 1}`]);
  }
  if (frame === 'flow') {
    const { stages, lanes } = flowCfg(b);
    const out = [];
    stages.forEach((name, i) => lanes.forEach((ln) => {
      const st = (name || '').trim() || `${i + 1}단계`;
      const lane = (ln.n || '').trim();
      out.push([flowKey(i, ln.k), lanes.length > 1 && lane ? `${st} · ${lane}` : st]);
    }));
    return out;
  }
  // 갈래·이음·마인드맵은 칸이 없다. 선과 위치가 의미라 「넣을 칸」이 성립하지 않는다
  return [];
}

/* 끄는 동안 판 위쪽이 갈라지고 지금 탭의 칸이 전부 표시된다.

   칸이 옆으로 밀려 화면 밖에 있으면 스크롤해도 그 위에 놓을 수 없다. 「공부」의
   그대로·내 말로·의문·그래서 나는 넷 중 화면에 보이는 것에만 놓을 수 있게 된다.
   그래서 끄는 동안 그 넷을 한 곳에 모아 표시해 밀려나 있어도 놓을 수 있게 한다.

   지금 탭의 칸만 표시한다. 다른 탭의 칸까지 세우면 공부에서 끄는데 나눔·할 일·회의가
   함께 뜬다. 옮기려는 곳은 지금 보고 있는 프레임 안이다.

   덮지 않고 영역을 나눈다. 판 위에 띄우면 그 아래 보이는 칸을 가려서, 원래 되던
   눈앞의 칸에 놓기가 끄는 동안 막힌다.

   여기서 다시 그리지 않는다. 끄는 도중에 조각을 지우면 끌기가 중단된다.
   표시와 숨김은 CSS(body.dragging)가 한다. */
function sendTray(b) {
  const slots = frameSlots(b, b.frame);
  if (slots.length < 2) return null;   // 칸이 하나뿐이면 모아 세울 것이 없다
  const grid = el('div', { class: 'sendgrid' });
  slots.forEach(([key, label]) => {
    const cell = el('div', { class: 'sendcell' }, el('span', { class: 'sc' }, label));
    grid.append(dropTarget(cell, (id) => {
      Store.put(b.id, b.frame, id, key);
      say(label);
      render();
    }));
  });
  return el('div', { class: 'sendtray' },
    el('div', { class: 'cap', title: tip('칸') }, '놓을 칸', el('span', {}, `${slots.length}`)),
    grid);
}

function renderStage(b) {
  const stage = $('#stage');
  stage.innerHTML = '';
  stage.classList.toggle('h', WIDE_FRAMES.has(b.frame));
  // 끄는 동안에만 보인다. 끌기가 시작된 뒤에 만들면 이미 늦으므로 미리 만들어 둔다
  const tray = sendTray(b);
  if (tray) stage.append(tray);
  // 이음 보기는 자체 안내를 따로 갖는다. 같은 내용을 두 줄로 표시하지 않는다
  /* 안내는 처음 한 번만 필요하다. 조각이 쌓인 뒤에도 남아 있으면 매번 같은 줄을 읽어야
     하고, 창을 좁히면 그 줄이 세 줄로 접혀 화면의 4분의 1을 차지한다
 (확인 결과: 420px 에서 안내 줄 하나가 223px). 집고 있는 동안의 줄은 안내가
     아니라 현재 상태를 나타내므로 남긴다. */
  if (picked) {
    stage.append(el('p', { class: 'hintline' },
      el('span', {}, el('b', {}, '조각 선택'), ' — 놓을 칸 누르기. Esc로 취소.')));
  } else if (!b.pieces.length && b.view !== 'link') {
    stage.append(el('p', { class: 'hintline' }, el('span', {}, VIEWS[b.view].line)));
  }
  (DRAW[b.frame] || viewGroup)(b, stage);
  if (WIDE_FRAMES.has(b.frame)) requestAnimationFrame(fitWideSlots);
}

/* 옆으로 접힌 줄만큼 칸을 넓힌다.

   칸 안쪽은 `width: max-content` 로 접힌 줄을 모두 포함하지만 칸 자신은 그 너비를 알지
 못한다. flex 가 칸의 내용 너비를 접히기 전(한 줄) 기준으로 재기 때문이다(확인 결과:
   안쪽 1598, 칸 282). 그래서 그린 뒤에 측정해 넣는다. */
function fitWideSlots() {
  const board = document.querySelector('#stage.h .board-h');
  // 좁은 창에서는 가로로 배치하지 않는다. 거기서 측정해 넣으면 한 줄짜리 칸이 글자 길이만큼 늘어난다
  if (!board || getComputedStyle(board).display !== 'flex') return;
  board.querySelectorAll(':scope > .slot').forEach((slot) => {
    const body = slot.querySelector('.slotbody');
    if (!body) return;
    slot.style.width = '';
    const cs = getComputedStyle(slot);
    const frame = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const want = Math.ceil(body.getBoundingClientRect().width + frame);
    if (want > slot.getBoundingClientRect().width) slot.style.width = `${want}px`;
  });
}

function render() {
  const b = Store.current();
  /* 거르개는 화면에 보일 때만 켜 둔다. 끄는 단추가 없는 채로 걸러진 화면이 남으면
     조각이 없는 이유를 알 수 없다. 나무·이음은 칸을 쓰지 않아 거르거나 끌 수 없고,
     지운 조각의 위치는 딱지 줄에서도 사라진다. */
  if (hereAt && (!CAN_FILTER(b) || !hereList(b).some((x) => x.loc === hereAt))) hereAt = null;
  // 고른 가지도 같은 규칙이다. 보이지 않는 곳에서 걸러진 채로 남으면 흐린 이유를 알 수 없다
  if (wordPick && (b.frame !== 'word' || !wordMap(b).hubs.some((h) => h.key === wordPick))) {
    wordPick = null;
  }
  // 고치던 조각이 이 판에 없으면 연 칸도 없다
  if (editId && !b.pieces.some((p) => p.id === editId)) editId = null;
  document.body.dataset.view = b.view || 'box';
  renderRail();
  renderTop(b);
  renderPile(b);
  renderStage(b);
}

/* ---------- 새 판 ---------- */

const STARTERS = [
  ['생각 정리', '머릿속에 있는 것을 쏟고 두 축으로 가르기.', 'quad'],
  ['할 일 정리', '오늘 언제 뭘 할지와 전체를 한 화면에.', 'todo'],
  ['공부', '영상·글을 보면서 옮기고, 덮은 채 내 말로 다시 쓰기.', 'study'],
  ['회의 준비', '목적 하나 고르고 꺼낼 것·안 꺼낼 것 가르기.', 'prep'],
  ['회의', '들은 것·정한 것·할 것·안 정한 것·의문.', 'meet'],
  ['아이데이션', '마구 쏟고 나중에 덩어리로 묶기.', 'group'],
  ['그냥 빈 판', '상황은 나중에.', 'group'],
];

/* ---------- 찾기 ----------

   판이 여럿이고 조각이 많으면 어느 판에 적었는지 기억나지 않을 때 판을 하나씩 열어
   봐야 하고, 결국 같은 내용을 다시 적게 된다. 분류를 새로 만들지 않고
   지금 있는 조각 전부를 대상으로 한다.

   찾은 뒤에 그 위치로 이동한다. 목록만 보여 주면 어디 있는지 알고도 이동할 수 없다.
   누르면 그 판을 열고 그 조각에 테를 두른다.

   지금 분류에서 보이지 않는 조각도 목록에는 나온다. 갈래에서 뿌리가 아니거나 이음에
   걸리지 않은 조각이 그렇다. 이동한 화면에서 보이지 않으면 그 사실을 알린다. */

let found = null;   // 찾아서 이동한 조각. 테를 잠깐 두른 뒤 자동으로 지운다

const FIND_SHOW = 60;

/* 그 판이 지금 서 있는 분류 이름. 칸 분류는 상황 이름이고 그림 분류는 보기 이름이다 */
function frameName(b) {
  return (b.view || 'box') === 'box'
    ? (KINDS[b.kind] || {}).name || b.kind
    : (VIEWS[b.view] || {}).name || b.view;
}

function findRows(q) {
  const want = q.trim().toLowerCase();
  if (!want) return [];
  const out = [];
  Store.boards().forEach((b) => {
    const place = Store.slots(b, b.frame);
    const slots = frameSlots(b, b.frame);
    const names = Object.fromEntries(slots);
    const kind = frameName(b);
    b.pieces.forEach((p) => {
      const hay = `${p.text || ''} ${p.loc || ''}`.toLowerCase();
      if (!hay.includes(want)) return;
      /* 판마다 서 있는 분류가 다르므로 분류 이름을 같이 적는다. 칸 이름만 적으면
         「의문」이 회의의 의문인지 공부의 의문인지 알 수 없다.
         칸이 없는 분류에서는 칸 이름을 비운다. 갈래·이음·마인드맵에는 더미가 없다. */
      const where = slots.length ? `${kind} · ${names[place[p.id]] || '더미'}` : kind;
      out.push({ b, p, where });
    });
  });
  out.sort((a, c) => (a.p.at < c.p.at ? 1 : a.p.at > c.p.at ? -1 : 0));
  return out;
}

// 찾은 글자에 테를 두른 줄. 어디가 걸렸는지 바로 보이게 한다
function markHit(text, want) {
  const i = text.toLowerCase().indexOf(want.toLowerCase());
  if (i < 0 || !want) return [text];
  return [text.slice(0, i), el('mark', {}, text.slice(i, i + want.length)), text.slice(i + want.length)];
}

function goFound(row, close) {
  close();
  Store.open(row.b.id);
  picked = null;
  hereAt = null;
  found = row.p.id;
  render();
  const node = document.querySelector('.found');
  if (node) node.scrollIntoView({ block: 'center' });
  else say('이 분류에서는 안 보이는 조각');
  // 테는 자동으로 사라진다. 사람이 지우는 조작을 더 만들지 않는다
  setTimeout(() => { if (found === row.p.id) { found = null; render(); } }, 4000);
}

function openFind() {
  const list = el('div', { class: 'findlist' });
  const cap = el('div', { class: 'findcap' }, '');
  let close = () => {};

  const draw = (q) => {
    list.innerHTML = '';
    const rows = findRows(q);
    if (!q.trim()) { cap.textContent = '모든 판의 조각 글과 위치'; return; }
    if (!rows.length) { cap.textContent = '없음'; return; }
    // 자른 것을 말하지 않으면 「이게 전부」로 읽힌다
    cap.textContent = rows.length > FIND_SHOW
      ? `${rows.length}개 중 ${FIND_SHOW}개 표시`
      : `${rows.length}개`;
    rows.slice(0, FIND_SHOW).forEach((row) => {
      list.append(el('button', { class: 'findrow', onclick: () => goFound(row, close) },
        el('span', { class: 'fw' },
          el('b', {}, row.b.title || (row.b.id === Store.INBOX ? '보관함' : '제목 없음')),
          el('span', { class: 'fs' }, row.where)),
        el('span', { class: 'ft' }, markHit(row.p.text || '', q.trim())),
        row.p.loc ? el('span', { class: 'fl' }, row.p.loc) : null));
    });
  };

  const box = el('input', {
    class: 'findbox', type: 'text', placeholder: '찾을 말',
    oninput: (e) => draw(e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Enter') return;
      const first = list.querySelector('.findrow');
      if (first) first.click();
    },
  });

  const back = openModal((shut) => {
    close = shut;
    return el('div', { class: 'find' }, box, cap, list);
  });
  draw('');
  box.focus();
  return back;
}

function openModal(content) {
  const back = el('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) back.remove(); } },
    el('div', { class: 'modal' }, content(() => back.remove())));
  document.body.append(back);
  return back;
}

/* ---------- 예시 ----------

   넷을 한 화면에 모으면 지금 쓰는 탭의 예시를 보려고 다른 예시를 지나쳐 내려가야 하고,
   아홉 탭 중 넷만 담긴다. 그래서 지금 켜 놓은 탭 하나만 연다.
   다른 탭 예시는 그 탭을 누르고 다시 열면 나온다.

   예시는 탭마다 다른 내용을 쓴다. 같은 조각 여섯 개를 아홉 탭에 모두 적용하면 어느
   탭에서도 자연스럽지 않다. 대신 네 항목은 아홉이 같다. 쏟은 것, 그래서 화면이 이렇게,
   읽는 법, 막히면. 화면은 실제 칸·카드 클래스로 그리므로 앱이 바뀌면 예시도 같이 바뀐다. */

const egCard = (t, ...extra) => {
  const chips = extra.filter(Boolean);
  return el('div', { class: 'placed eg' },
    el('div', { class: 'line' }, el('div', { class: 't' }, t)),
    chips.length ? el('div', { class: 'meta' }, chips) : null);
};

const egChip = (t, cls) => el('span', { class: 'egchip ' + (cls || '') }, t);

function egSlot(cap, kids, tone) {
  return el('div', { class: 'slot eg ' + (tone || '') },
    cap ? el('div', { class: 'cap' }, cap) : null, kids);
}

// 예시의 정리 전 원본. 이것을 보여 주지 않으면 정리된 화면이 원래 그랬던 것처럼 보인다
const egRaw = (cap, ...items) => el('div', {},
  el('div', { class: 'egnote' }, cap),
  el('div', { class: 'egsrc' }, items.map((t) => el('span', {}, t))));

const egRows = (cls, cap, rows) => el('div', { class: 'egread ' + cls },
  el('div', { class: 'cap' }, cap),
  rows.map(([a, b]) => el('div', { class: 'row' }, el('b', {}, a), el('span', {}, b))));

const egRead = (...rows) => egRows('', '읽는 법', rows);
const egStuck = (...rows) => egRows('stuck', '막히면', rows);
const egStep = (t) => el('div', { class: 'egnote step' }, t);

/* 같은 모양이 상황마다 어떻게 달라지는지. 모양 보기 셋에만 붙는다.
   이것을 보여 주지 않으면 셋이 같은 도구로 읽힌다 */
function egVary(cap, pick, ask) {
  return el('div', { class: 'egvary' },
    el('div', { class: 'cap' }, cap),
    Object.entries(KINDS).map(([k, v]) => el('div', { class: 'row' },
      el('b', {}, v.name),
      el('span', {}, pick(TUNE[k] || TUNE.group)),
      ask ? el('i', {}, ask(TUNE[k] || TUNE.group)) : null)));
}

// 오늘 띠 한 줄. 실제 화면과 같은 계산으로 높이를 준다
const egDay = (tm, dur, txt, mins, on) => el('div', {
  class: 'row' + (on ? ' on' : ''),
  style: `min-height:${Math.round(Math.min(190, 34 + mins * 0.7))}px`,
},
  el('span', { class: 'tm' }, tm),
  el('span', { class: 'bar' + (mins ? '' : ' none') }),
  el('span', { class: 'dur' + (mins ? '' : ' none') }, dur),
  el('span', { class: 'txt' }, txt));

const EG = {
  group: {
    name: '묶음', what: '덩어리로 모아 이름 붙이기',
    when: '머릿속 것을 다 쏟았는데 무엇이 무엇인지 모를 때',
    gain: '아홉 개가 세 덩어리가 되면 그때부터 손댈 수 있는 크기',
    no: '이미 무엇이 무엇인지 아는 것을 다시 묶는 자리는 아님',
    draw: () => el('div', {},
      egRaw('떠오르는 대로 아홉 줄. 여기까지는 순서도 뜻도 없음',
        '자취 요리', '5분 스트레칭', '공부방 브이로그', '편의점 신상 먹방',
        '시험기간 타임랩스', '원룸 정리', '다이소 문구 리뷰', '아침 루틴', '책상 세팅'),
      egStep('↓ 비슷한 것끼리 옮기고, 모인 것을 보고 이름 붙이기'),
      el('div', { class: 'eggrid three' },
        egSlot('먹는 것', [egCard('자취 요리'), egCard('편의점 신상 먹방')]),
        egSlot('내 방', [egCard('원룸 정리'), egCard('책상 세팅'), egCard('다이소 문구 리뷰')]),
        egSlot('하루 루틴', [egCard('아침 루틴'), egCard('5분 스트레칭'),
          egCard('공부방 브이로그'), egCard('시험기간 타임랩스')])),
      el('div', { class: 'egline' }, el('b', {}, '의문'), egChip('0'), el('span', {}, '펼치기')),
      egRead(
        ['이름은 나중에', '먼저 옮기기. 이름부터 짓는 순서는 막히는 순서'],
        ['하나만 남은 덩어리', '덩어리가 아님. 옆에 붙이거나 이름을 더 넓게'],
        ['어디에도 안 가는 것', '남겨 두기. 그것이 다음 덩어리의 씨앗'],
        ['커진 덩어리', '「내 방」이 열 장을 넘으면 그것만 새 판으로 빼기'],
        ['⌘⇧Enter', '적다가 궁금해진 것은 의문 줄로. 하던 자리 그대로'],
        ['지금 여기', '더미 위에 주제를 적어 두면 그 뒤에 담는 조각마다 딱지가 저절로']),
      egStuck(
        ['덩어리가 너무 많은 때', '아직 안 묶은 것. 비슷한 덩어리 둘을 하나로'],
        ['한 덩어리에 다 들어감', '기준이 너무 넓은 상태. 그 덩어리 안에서 다시 묶기'])),
  },

  quad: {
    name: '나눔', what: '두 축으로 가르기',
    when: '할 것은 많은데 무엇부터인지 모를 때',
    gain: '자리가 곧 답. 오른쪽 위부터 하면 되는 상태',
    no: '항목이 셋 이하면 그냥 순서를 매기는 쪽이 빠름',
    draw: () => el('div', {},
      egRaw('가르기 전. 여섯 개가 다 같은 무게',
        '내일 발표 자료', '계약서 검토', '운동 시작하기', '메일 정리', '책상 정리', '팀원 1대1'),
      egStep('↓ 가로는 급한지, 세로는 중요한지. 축 이름은 마음대로'),
      el('div', { class: 'egquad' },
        el('div', { class: 'ytop' }, '↑ 중요한 것'),
        el('div', { class: 'cells' },
          egSlot('안 급하고 중요', [egCard('운동 시작하기'), egCard('팀원 1대1')], 'good'),
          egSlot('급하고 중요', [egCard('내일 발표 자료'), egCard('계약서 검토')], 'prim'),
          egSlot('둘 다 아님', [egCard('책상 정리')], 'ghost'),
          egSlot('급하지만 안 중요', [egCard('메일 정리')], 'amber')),
        el('div', { class: 'xrow' },
          el('span', {}, '안 급한 것'), el('span', {}, '급한 것 →'))),
      egRead(
        ['오른쪽 위', '지금. 여기가 둘을 넘으면 아직 안 가른 것'],
        ['왼쪽 위', '날짜를 잡는 자리. 안 잡으면 영영 그대로'],
        ['오른쪽 아래', '몰아서 한 번에. 하나씩 하는 순간 하루가 통째로'],
        ['왼쪽 아래', '안 해도 되는 것. 지워도 되는지 한 번 보기'],
        ['빈 칸', '빈 칸도 답. 왼쪽 위가 비었으면 급한 것만 쫓고 있는 상태']),
      egStuck(
        ['네 칸이 고르게 참', '축이 안 갈림. 「내가 함 · 남이 함」처럼 다른 축으로'],
        ['다 중요해 보이는 때', '중요한 것은 위가 아니라 맨 위 둘. 셋째부터는 내리기'])),
  },

  todo: {
    name: '할 일', what: '걸리는 시간을 적으면 오늘 순서가 시각으로',
    when: '오늘 무엇을 언제 할지 정할 때',
    gain: '하루가 넘치는지가 세지 않아도 눈에',
    no: '오늘 안 할 것까지 여기 두면 띠가 거짓말',
    draw: () => el('div', {},
      egRaw('시각은 안 적는 자리. 걸리는 시간만',
        '가격표 다시 짜기 45분', '제안서 초안 쓰기 3시간', '자료 찾기', '메일 답장 10분'),
      egStep('↓ 시작 시각 하나만 정하면 나머지는 저절로'),
      el('div', { class: 'egnow' },
        el('span', { class: 'lbl' }, '지금'),
        el('span', { class: 'txt' }, '가격표 다시 짜기'),
        el('span', { class: 'dur' }, '45분')),
      el('div', { class: 'egstrip' },
        el('div', { class: 'head' },
          el('b', {}, '오늘'), el('span', {}, '시작 12:30'),
          el('span', { class: 'sum' }, '쭉 하면 4시간 15분 · 16:45에 끝')),
        egDay('12:30', '45분', '가격표 다시 짜기', 45, true),
        egDay('13:15', '3시간', '제안서 초안 쓰기', 180),
        egDay('16:15', '시간 미정', '자료 찾기', 0),
        egDay('16:15', '10분', '메일 답장', 10)),
      egStep('↓ 아래 네 칸은 오늘 것만이 아니라 전부'),
      el('div', { class: 'eggrid four' },
        egSlot('할 일', [egCard('가격표 다시 짜기', egChip('오늘'), egChip('45분', 'prim')),
          egCard('제안서 초안 쓰기', egChip('오늘'), egChip('3시간', 'prim'))], 'prim'),
        egSlot('기다리는 중', [egCard('견적 답장', egChip('상대 쪽', 'warn'))]),
        egSlot('언젠가', [egCard('블로그 새로 열기')], 'ghost'),
        egSlot('끝', [egCard('메일 답장')], 'good')),
      egRead(
        ['줄 길이', '길이가 곧 걸리는 시간. 3시간짜리는 45분짜리의 세 배 높이'],
        ['빗금 막대', '시간 미정. 이것이 많으면 계획이 아니라 목록'],
        ['맨 위 지금 줄', '별을 찍은 것, 없으면 오늘 띠의 첫 줄'],
        ['↑↓', '순서를 바꾸면 시각이 따라 바뀜. 시각을 직접 적는 자리는 없음'],
        ['기다리는 중', '내 손을 떠난 것. 여기 오래 있으면 다시 찔러야 하는 신호'],
        ['지금 하는 일', '더미 위에 프로젝트를 적어 두면 딱지가 붙고, 그 딱지로 걸러 보기']),
      egStuck(
        ['끝나는 시각이 너무 늦은 때', '오늘을 뗄 것을 고르는 자리. 「언젠가」로 내리기'],
        ['시간이 늘 안 맞는 때', '한 조각이 너무 큼. 갈래 탭에서 쪼개고 오기'])),
  },

  meet: {
    name: '회의', what: '정한 것 · 할 것 · 안 정한 것',
    when: '회의 중에 받아 적고, 끝난 뒤 5분 안에 정리할 때',
    gain: '붙여 넣으면 그대로 회의록. 담당 빈칸 수가 맨 위 한 줄로',
    no: '혼자 생각을 정리하는 자리는 아님',
    draw: () => el('div', {},
      egRaw('회의 중에는 가르지 않음. 들리는 대로 한 줄씩',
        '검색 결과에 우리가 없음', '광고비 1달에 1억', '구독제는 무리',
        '무료 리포트로 사람 모으기', '담당 정하기', '경쟁사 사이트 뜯어보기'),
      egStep('↓ 끝난 뒤 셋으로 옮기기. 참석자를 적어야 담당자를 고를 수 있는 상태'),
      el('div', { class: 'egbar' }, el('b', {}, '참석'), el('span', {}, '조혜진, 나')),
      el('div', { class: 'egwarn' }, '담당자나 기한 빈칸 1개. 둘 다 있어야 실제로 실행.'),
      el('div', { class: 'eggrid three' },
        egSlot('정한 것', [
          egCard('무료 리포트로 사람 모으기', egChip('왜 · 광고비 1달에 1억')),
          egCard('구독제는 무리', egChip('＋ 왜', 'warn'))], 'good'),
        egSlot('할 것', [
          egCard('담당 정하기', egChip('조혜진'), egChip('9/2')),
          egCard('경쟁사 사이트 뜯어보기', egChip('담당 빈칸', 'warn'))], 'prim'),
        egSlot('안 정한 것', [egCard('광고비 1달에 1억')], 'amber')),
      el('div', { class: 'egline' }, el('b', {}, '들은 것'), egChip('1'), el('span', {}, '펼치기')),
      el('div', { class: 'egline' }, el('b', {}, '의문'), egChip('1'), el('span', {}, '펼치기')),
      egRead(
        ['정한 것에 왜', '왜가 없는 결정은 다음 회의에서 다시 논의. 한 줄이면 충분'],
        ['할 것에 담당과 기한', '둘 중 하나만 비면 아무도 안 하는 일. 빈칸 수는 맨 위 한 줄이'],
        ['안 정한 것', '정해야 하는데 못 정한 것. 다음 안건이 여기서 나옴'],
        ['들은 것', '판단 없이 담는 자리. 셋 중 어디도 아닌 맥락'],
        ['의문', '궁금한 것. 안건이 아닐 수도 있어 회의 중에 쫓지 않음'],
        ['글로 복사', '정한 것 → 할 것 → 안 정한 것 → 들은 것 → 의문 순서로 나감'],
        ['지금 안건', '안건이 넘어갈 때마다 더미 위를 바꾸기. 나중에 안건별로 걸러 보기']),
      egStuck(
        ['정한 것이 너무 많은 때', '대부분 결정이 아니라 들은 것. 들은 것으로 내리기'],
        ['회의 중에 못 따라감', '전부 들은 것에 던지기. 가르는 것은 끝난 뒤'])),
  },

  study: {
    name: '공부', what: '그대로 옮기고, 덮은 채 내 말로 다시 쓰기',
    when: '영상·글을 보면서. 다 보고 나서가 아니라 보는 중에',
    gain: '위치별 한 줄만 이어 읽어도 전체가 서는 상태',
    no: '이미 아는 것을 다시 옮겨 적는 자리는 아님',
    draw: () => el('div', {},
      egRaw('보면서 그대로 집은 것. 옆에 위치를 같이',
        '3:20 GEO는 생성 답변에 실리는 것', '3:20 SEO와 목표가 다름',
        '12:05 인용의 조건은 또렷한 출처', '12:05 표와 목록이 잘 실림',
        '25:40 측정 도구가 아직 없음'),
      egStep('↓ 파트를 지나칠 때마다 그 자리에서 한 줄로 접기'),
      el('div', { class: 'eglocbar' },
        el('div', { class: 'cap' }, el('b', {}, '위치별 한 줄'), el('span', {}, '2 / 3')),
        el('div', { class: 'locrow' }, el('span', { class: 'at' }, '3:20'),
          el('span', { class: 'one' }, 'GEO는 답변에 실리는 것, SEO는 목록에 뜨는 것'),
          el('span', { class: 'n' }, '2')),
        el('div', { class: 'locrow' }, el('span', { class: 'at' }, '12:05'),
          el('span', { class: 'one' }, '실리는 조건은 또렷한 출처와 표 정리'),
          el('span', { class: 'n' }, '2')),
        el('div', { class: 'locrow' }, el('span', { class: 'at' }, '25:40'),
          el('span', { class: 'one dim' }, '이 파트를 한 줄로'),
          el('span', { class: 'n' }, '1'),
          el('span', { class: 'warn' }, '내 말 없음'))),
      egStep('↓ 위치를 누르면 그 파트만'),
      el('div', { class: 'eggrid four' },
        egSlot('그대로', [egCard('인용의 조건은 또렷한 출처', egChip('12:05')),
          egCard('표와 목록이 잘 실림', egChip('12:05'))]),
        egSlot('내 말로', [egCard('쓰는 사람이 아니라 답변이 읽는다고 치고 씀',
          egChip('12:05'))], 'good'),
        egSlot('의문', [egCard('표가 왜 더 잘 실리는가', egChip('12:05'))], 'amber'),
        egSlot('그래서 나는', [egCard('우리 글 맨 위에 요약 표 넣기')], 'prim')),
      egRead(
        ['위치별 한 줄', '나중에 그 줄들만 이어 읽어도 전체가 섬. 목차이자 요약'],
        ['내 말 없음', '그대로만 옮기고 안 바꾼 파트. 거기가 아직 모르는 자리'],
        ['원문 덮기', '그대로 칸을 덮고 내 말만 보기. 막히면 그 자리가 구멍'],
        ['접히지 않는 파트', '조각 다섯을 한 줄로 못 줄이면 아직 그 파트를 모르는 것'],
        ['그래서 나는', '내가 바꿀 것 하나. 없으면 안 읽은 것과 같음'],
        ['지금 위치', '되감을 수 없으니 그 자리에서. 카드의 위치 딱지를 눌러 고치기']),
      egStuck(
        ['그대로만 쌓이는 때', '옮겨 적기는 공부가 아님. 한 파트 끝날 때마다 내 말로 하나'],
        ['위치를 안 적은 때', '나중에 되찾을 길이 없는 상태. 파트가 바뀔 때만 적어도 충분'])),
  },

  prep: {
    name: '준비', what: '목적 하나 고르고 꺼낼 것 가르기',
    when: '회의·발표 전. 들어가기 10분 전에도',
    gain: '무엇을 얻어 나올지가 먼저 정해진 상태로 들어감',
    no: '무엇을 할 자리인지 모르는 회의는 준비가 아니라 취소 대상',
    draw: () => el('div', {},
      egRaw('머릿속에 있는 것을 먼저 쏟기',
        'A안과 B안 중 하나 고르기', '예산이 얼마인지 모름', 'B안이 2주 더 걸림',
        '디자인은 나중 얘기', '누가 결정하는지', 'A안 시안 보여 주기'),
      egStep('↓ 목적을 하나 누르면 네 칸이 묻는 것이 바뀜'),
      el('div', { class: 'eggoal' },
        el('span', { class: 'lbl' }, '이 자리의 목적'),
        el('span', { class: 'g' }, '정보 공유'),
        el('span', { class: 'g on' }, '의사 결정'),
        el('span', { class: 'g' }, '문제 해결'),
        el('span', { class: 'g' }, '아이디어'),
        el('span', { class: 'lbl' }, '30분 안에')),
      el('div', { class: 'eggrid four' },
        egSlot('무엇이 결정되어 있어야 하는가',
          [egCard('A안과 B안 중 하나 고르기')], 'prim'),
        egSlot('선택지와 내 안',
          [egCard('A안 시안 보여 주기'), egCard('B안이 2주 더 걸림')]),
        egSlot('결정권자 · 판단 기준',
          [egCard('누가 결정하는지'), egCard('예산이 얼마인지 모름')], 'amber'),
        egSlot('오늘은 안 꺼낼 것', [egCard('디자인은 나중 얘기')], 'ghost')),
      egRead(
        ['목적이 먼저', '목적을 안 고르면 네 칸이 일반 질문. 고르면 이 회의의 질문'],
        ['첫 칸', '이것이 비면 회의가 안 끝나는 자리. 한 문장으로'],
        ['셋째 칸', '기준이 없으면 결정도 없는 자리. 모르는 것을 먼저 세우기'],
        ['안 꺼낼 것', '떠오른 것을 버리지 않고 옆에 두는 자리. 회의가 새는 것을 막는 칸'],
        ['30분 안에', '시간을 적으면 꺼낼 것이 저절로 줄어듦']),
      egStuck(
        ['꺼낼 것이 열 장', '30분에 안 들어감. 셋만 남기고 나머지는 안 꺼낼 것으로'],
        ['첫 칸이 안 써지는 때', '이 회의는 결정 자리가 아닐 수 있음. 목적을 다시 고르기'])),
  },

  flow: {
    name: '흐름', what: '순서대로 늘어놓기',
    when: '먼저와 나중이 있을 때. 단계를 밟아야 하는 일',
    gain: '지금 어디까지 왔는지, 빠진 단계가 어디인지',
    no: '순서가 없는 것을 억지로 세우면 없는 순서를 지어내는 자리',
    art: VIEWS.line.art,
    draw: () => el('div', {},
      egRaw('한 줄씩 적힌 것. 아직 순서가 없음',
        '신청서 받기', '서류 확인', '결과 메일', '문의 답하기', '보완 요청', '카드 발송'),
      egStep('↓ 가로가 단계, 세로가 줄. 줄을 늘리면 두 흐름이 나란히'),
      el('div', { class: 'egflow' },
        el('div', { class: 'lane' },
          el('span', { class: 'lb' }, '우리 쪽'),
          egSlot('1 신청', [egCard('신청서 받기')]),
          egSlot('2 심사', [egCard('서류 확인'), egCard('보완 요청')]),
          egSlot('3 발송', [egCard('카드 발송'), egCard('결과 메일')])),
        el('div', { class: 'lane' },
          el('span', { class: 'lb' }, '고객 쪽'),
          egSlot('', [egCard('문의 답하기')]),
          egSlot('', [], 'ghost'),
          egSlot('', [], 'ghost'))),
      egRead(
        ['가로', '단계. 왼쪽이 먼저, 오른쪽이 나중'],
        ['세로', '줄. 「우리 쪽 · 고객 쪽」처럼 나란히 가는 것, 「A안 · B안」처럼 갈리는 것'],
        ['빈 칸', '빈 칸이 곧 「여기는 아직 아무것도 없음」. 심사·발송에 고객 쪽이 빔'],
        ['한 칸에 여러 장', '그 단계가 실제로 무거운 자리. 쪼갤 후보'],
        ['단계 이름', '앞에서 무엇을 눌렀느냐로 기본값이 갈림. 언제든 고쳐 쓰기']),
      egStuck(
        ['단계가 너무 많은 때', '한 화면에 안 들어옴. 크게 셋으로 묶고 안은 갈래 탭에서'],
        ['어느 단계인지 애매', '그건 순서가 아니라 무리. 앞의 여섯 탭 중 묶음으로']),
      egVary('앞에서 무엇을 눌렀느냐로 갈리는 단계 이름',
        (t) => t.line.join(' · '), (t) => (t.lane ? `줄 ${t.lane}` : '줄 없이 하나'))),
  },

  tree: {
    name: '갈래', what: '큰 것을 작게 쪼개기',
    when: '덩어리가 너무 커서 손댈 데를 모를 때. 원인을 파고들 때',
    gain: '더 못 쪼갤 때까지 내려가면 거기가 실제로 손댈 자리',
    no: '이미 작은 것을 더 쪼개면 할 일만 늘어나는 자리',
    art: VIEWS.tree.art,
    draw: () => el('div', {},
      egRaw('한 덩어리. 이대로는 손댈 데가 없는 상태', '매출이 그대로'),
      egStep('↓ 「왜」를 한 번 물을 때마다 한 층. 두 층이면 대개 손에 잡히는 크기'),
      el('div', { class: 'egtree' },
        el('div', { class: 'row d0' }, egCard('매출이 그대로')),
        el('div', { class: 'row d1' },
          el('div', { class: 'br' }, egCard('사람이 안 옴')),
          el('div', { class: 'br' }, egCard('와도 안 삼'))),
        el('div', { class: 'row d2' },
          el('div', { class: 'br' }, egCard('검색에 안 나오는 것')),
          el('div', { class: 'br' }, egCard('가격표가 없음')))),
      egRead(
        ['맨 위', '오늘 손댈 큰 것 하나. 둘 이상이면 판을 나누기'],
        ['한 층 내려갈 때', '「왜 그런가」를 한 번 묻기. 답이 둘이면 가지가 둘'],
        ['맨 아래', '거기가 실제로 손댈 자리. 「검색에 안 나오는 것」은 할 일로 옮길 수 있음'],
        ['깊이', '두 층까지. 세 층이 필요하면 그 가지만 새 판으로'],
        ['가지 수', '한 자리에서 넷을 넘으면 아직 안 쪼갠 것. 둘씩 묶어 층을 만들기']),
      egStuck(
        ['아래가 여전히 큼', '한 번 더 「왜」. 「사람이 안 옴」은 아직 할 일이 아님'],
        ['가지가 서로 겹침', '겹치면 같은 것을 두 번 세는 중. 하나로 합치기']),
      egVary('맨 위에 놓는 것', (t) => t.treeTop, (t) => t.treeAsk)),
  },

  link: {
    name: '이음', what: '무엇 때문에 무엇인지',
    when: '항목은 많은데 서로 어떻게 얽혔는지 모를 때. 급소를 찾을 때',
    gain: '선이 많이 붙은 자리가 급소. 안 이은 줄이 짧아지는 것이 진도',
    no: '서로 상관없는 것을 억지로 이으면 없는 관계를 지어내는 자리',
    art: VIEWS.link.art,
    draw: () => el('div', {},
      egRaw('여섯 장. 칸으로는 「같은 무리」까지만 말할 수 있음',
        '검색 결과에 없음', '광고비 1달에 1억', '구독제는 무리',
        '무료 리포트로 사람 모으기', '담당 정하기', '경쟁사 사이트 뜯어보기'),
      egStep('↓ 카드를 카드 위로 끌면 이어지는 선. 자리는 저절로, 사람은 잇기만'),
      el('div', { class: 'eglink' },
        el('div', { class: 'col free' },
          el('div', { class: 'cap' }, '아직 안 이은 것 2'),
          egCard('담당 정하기'),
          egCard('경쟁사 사이트 뜯어보기')),
        el('div', { class: 'col' }, egCard('검색 결과에 없음'), egCard('광고비 1달에 1억')),
        el('div', { class: 'mid' }, egChip('때문에', 'prim'), egChip('때문에', 'prim')),
        el('div', { class: 'col' }, egCard('구독제는 무리'),
          egCard('무료 리포트로 사람 모으기'))),
      el('div', { class: 'eglegend' },
        el('span', {}, egChip('때문에', 'prim'), '이것 때문에 저것'),
        el('span', {}, egChip('방해', 'warn'), '앞의 것이 뒤의 것을 막는 사이'),
        el('span', {}, egChip('같음'), '둘이 사실 같은 말'),
        el('span', { class: 'muted' }, '선을 누를 때마다 뜻이 한 칸씩. 한 바퀴 돌면 선 끊기')),
      egRead(
        ['왼쪽 · 오른쪽', '왼쪽이 원인, 오른쪽이 결과. 자리 잡기는 사람 몫이 아님'],
        ['선이 많이 붙은 카드', '거기가 급소. 하나 풀면 여러 개가 같이 풀림'],
        ['아직 안 이은 줄', '그 길이가 곧 아직 정리 안 된 양. 짧아지는 것이 진도'],
        ['돌고 도는 것', '고리가 생기면 따로 세워 알려 줌. 대개 둘 중 하나가 원인이 아님'],
        ['선 이름', '앞에서 무엇을 눌렀느냐로 갈림. 할 일에서는 「먼저 · 막힘 · 같이」']),
      egStuck(
        ['다 이어 버림', '전부 이으면 아무것도 안 이은 것과 같음. 확실한 것만'],
        ['어느 쪽이 원인인지 모름', '선을 눌러 방향을 뒤집어 보기. 어색한 쪽이 아님']),
      egVary('선의 뜻. 자리는 늘 셋, 이름은 앞의 여섯이',
        (t) => `${t.link.cause} · ${t.link.block} · ${t.link.same}`, (t) => t.linkAsk)),
  },
};

/* 지금 켠 탭 하나만 연다. 아홉을 한 화면에 쌓으면 필요한 것을 찾으려고 나머지를 지나쳐야 한다 */
function showTerms() {
  openModal((close) => el('div', { class: 'guide terms' },
    el('div', { class: 'ghead' },
      el('h2', {}, '말뜻'),
      el('span', { class: 'what' }, '이 판에서 쓰는 이름'),
      el('button', { class: 'ghost sm', onclick: close }, '닫기')),
    el('div', { class: 'termlist' }, TERMS.map(([w, d, more]) => el('div', { class: 'term' },
      el('b', {}, w),
      el('span', { class: 'd' }, d),
      el('span', { class: 'more' }, more))))));
}

function showGuide() {
  const g = EG[Store.current().frame] || EG.group;
  openModal((close) => el('div', { class: 'guide' },
    el('div', { class: 'ghead' },
      g.art ? svgArt(g.art) : null,
      el('h2', {}, g.name),
      el('span', { class: 'what' }, g.what),
      el('button', { class: 'ghost sm', onclick: close }, '닫기')),
    el('div', { class: 'gwhen' },
      el('div', {}, el('i', {}, '언제'), el('span', {}, g.when)),
      el('div', {}, el('i', {}, '얻는 것'), el('span', {}, g.gain)),
      el('div', {}, el('i', {}, '아닐 때'), el('span', {}, g.no))),
    g.draw(),
    el('p', { class: 'gtail' }, '다른 탭 예시는 그 탭을 누르고 예시를 다시 열기.')));
}


function newBoard() {
  openModal((close) => el('div', { class: 'starter' },
    el('h2', {}, '무엇을 하려는 판인가'),
    el('p', { class: 'sub' }, '고른 것에 맞는 틀이 먼저 씌워질 뿐. 틀은 언제든 교체 가능.'),
    el('div', { class: 'opts' },
      STARTERS.map(([name, desc, kind]) => el('button', {
        class: 'opt',
        onclick: () => {
          Store.addBoard({ kind, view: 'box', frame: kind });
          close(); picked = null; render(); $('#board-title').focus();
        },
      }, el('b', {}, name), el('span', {}, desc))))));
}

function pullFromInbox() {
  const inbox = Store.inbox();
  const cur = Store.current();
  if (!inbox.pieces.length) { alert('보관함 비어 있음.'); return; }
  const chosen = new Set();
  openModal((close) => {
    const wrap = el('div', { class: 'starter' });
    const btns = [];
    const mark = (btn, on) => { btn.style.borderColor = on ? 'var(--primary)' : ''; };
    const list = el('div', { class: 'opts' },
      inbox.pieces.map((p) => {
        const btn = el('button', { class: 'opt' }, el('span', {}, p.text));
        btns.push([p.id, btn]);
        btn.addEventListener('click', () => {
          if (chosen.has(p.id)) { chosen.delete(p.id); mark(btn, false); }
          else { chosen.add(p.id); mark(btn, true); }
        });
        return btn;
      }));
    // 전체를 한 번에 옮기는 경우가 많다. 스무 개를 하나씩 누르게 하지 않는다
    const all = el('button', { class: 'ghost sm' }, '전부');
    all.addEventListener('click', () => {
      const on = chosen.size < btns.length;
      chosen.clear();
      btns.forEach(([id, btn]) => { if (on) chosen.add(id); mark(btn, on); });
      all.textContent = on ? '전부 해제' : '전부';
    });
    wrap.append(
      el('h2', {}, '보관함에서 가져오기'),
      el('p', { class: 'sub' }, '이 판으로 옮길 것 선택. 옮긴 것은 보관함에서 제외.'),
      el('div', { style: 'margin-bottom:10px' }, all),
      list,
      el('div', { style: 'display:flex;gap:8px;margin-top:18px;justify-content:flex-end' },
        el('button', { class: 'ghost', onclick: close }, '그만'),
        el('button', {
          class: 'primary',
          onclick: () => { Store.movePieces(Store.INBOX, cur.id, [...chosen]); close(); render(); },
        }, '가져오기')));
    return wrap;
  });
}

/* ---------- 연결 ---------- */

$('#new-board').addEventListener('click', newBoard);
$('#from-inbox').addEventListener('click', pullFromInbox);

$('#board-title').addEventListener('input', (e) => {
  Store.patchBoard(Store.current().id, { title: e.target.value });
  renderRail();
});

/* 레일 접기.

   접힘도 서버 저장소에 담는다. 브라우저 저장소는 주소가 조금만 달라도 별도 저장소라
   같은 판을 열어도 창 모양이 달라진다. 판 데이터와 분리해 `ui` 에 두므로
   내보내기에는 포함되지 않는다. */
const rail = $('#rail');
const foldBtn = $('#fold-rail');

function paintFold(on) {
  rail.classList.toggle('folded', on);
  foldBtn.textContent = on ? '›' : '‹';
  foldBtn.title = on ? '판 목록 펼치기' : '판 목록 접기';
}
function setFold(on) { paintFold(on); Store.ui('railFolded', !!on); }
foldBtn.addEventListener('click', () => setFold(!rail.classList.contains('folded')));
paintFold(false);

/* 좁은 창에서는 레일을 표시하지 않는다. 그 폭에서 208px 은 칸이 쓸 공간을 대부분 차지한다.
   대신 판 이름 옆 단추로 덮어 연다. 판을 고르면 자동으로 닫힌다. */
const openRail = $('#open-rail');
const shutRail = () => rail.classList.remove('open');
openRail.addEventListener('click', (e) => { e.stopPropagation(); rail.classList.toggle('open'); });
rail.addEventListener('click', (e) => { if (e.target.closest('.board-item')) shutRail(); });
document.addEventListener('click', (e) => {
  if (rail.classList.contains('open') && !rail.contains(e.target)) shutRail();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shutRail(); });

const input = $('#piece-input');
input.addEventListener('keydown', (e) => {
  // 한글 조합을 끝내는 Enter 는 제출이 아니다. 이 가드가 없으면 한 번 입력한 것이 두 번 들어간다
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter') return;
  // ⌘⇧Enter 는 위 전역 핸들러가 받는다. 여기서 먼저 처리하면 더미로 들어간다
  if (e.metaKey || e.ctrlKey) return;
  if (e.shiftKey) return;
  e.preventDefault();
  const v = input.value.trim();
  if (!v) return;
  const cur = Store.current();
  const made = Store.addPiece(cur.id, v);
  // 지금 보고 있는 위치를 함께 기록한다. 나중에 그 위치만 골라 볼 수 있어야 한다
  if (made && cur.at) Store.setMeta(cur.id, made.id, { loc: cur.at });
  input.value = '';
  render();
  input.focus();
});

const drop = $('#drop-input');
const echo = $('#drop-echo');
/* 의문 단추는 지금 판의 의문 칸으로 보낸다. 모드가 아니라 동작이다.
   눌렀을 때 무엇이 바뀌는지 화면에 보이지 않는 모드는 쓰이지 않는다. */
const qBtn = $('#drop-q');
qBtn.addEventListener('click', () => {
  if (drop.value.trim()) { askNow(drop); return; }
  if (input.value.trim()) { askNow(input); return; }
  input.focus();
});

const say = (msg) => {
  echo.textContent = msg;
  setTimeout(() => { echo.textContent = ''; }, 1500);
};

/* 보관함 바는 지금 판과 상관없는 내용을 담아 보관함으로 보낸다.
   의문은 여기가 아니라 아래 askNow 가 담당한다. */
function sendDrop() {
  const v = drop.value.trim();
  if (!v) return false;
  Store.addPiece(Store.INBOX, v);
  drop.value = '';
  say('보관함에 저장');
  render();
  return true;
}

/* 적고 있던 글을 지금 판의 의문 칸으로 바로 넣는다.

   모드를 켜고 적고 확정하는 세 동작이면 회의 중에 쓰이지 않는다. 한 번에 끝나야 하고,
   포커스를 옮기지 않아야 한다. 적던 칸에서 포커스가 옮겨 가면 다음 문장이 끊긴다. */
function askNow(box) {
  const v = box.value.trim();
  if (!v) return false;
  const b = Store.current();
  const made = Store.addPiece(b.id, v);
  if (!made) return false;
  Store.put(b.id, b.frame, made.id, 'ask');
  Store.setMeta(b.id, made.id, { q: true, from: b.id });
  if (b.at) Store.setMeta(b.id, made.id, { loc: b.at });
  box.value = '';
  say('의문 칸으로');
  render();
  box.focus();
  return true;
}

drop.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter') return;
  // 수식키가 붙은 Enter 는 아래 전역 핸들러가 처리한다. 여기서 한 번 더 처리하면
  // 같은 입력이 두 곳에서 실행되어 보관함 바를 비운 뒤 더미 칸까지 보낸다
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  sendDrop();
});

/* ⌘⇧Enter. 이것은 의문이다.

   적고 있던 글이 있으면 그 글이 곧바로 지금 판의 의문 칸으로 들어간다. 모드가 바뀌지도
   않고 포커스가 옮겨 가지도 않는다. 적고 있지 않았고 조각을 집어 뒀으면 그 조각이 간다.

   ⌘. 는 보관함 바를 여는 단축키로 둔다. 지금 판과 상관없는 내용을 담는 경로다. */
function askByKey(box) {
  if (box && (box.id === 'piece-input' || box.id === 'drop-input') && askNow(box)) return;
  if (input.value.trim() && askNow(input)) return;
  if (!picked) return;
  const b = Store.current();
  Store.put(b.id, b.frame, picked, 'ask');
  say('의문 칸으로');
  picked = null;
  render();
}

// 조합이 끝나기를 기다리고 있는 칸. 기다리는 사이에 또 누르면 두 번 담긴다
let askPending = null;

document.addEventListener('keydown', (e) => {
  const cmd = e.metaKey || e.ctrlKey;

  if (cmd && e.shiftKey && e.key === 'Enter') {
    const box = document.activeElement;

    /* 한글을 입력 중이면 이 Enter 는 조합을 끝내는 키이기도 하다.
       여기서 그냥 반환하면 첫 입력은 조합만 끝나고 두 번째에야 담긴다.
       막지 않고 조합이 끝나기를 기다렸다가 담는다. 지금 담으면 조합 중이던 글자가
       비워진 칸에 다시 들어가므로, 기본 동작이 끝난 뒤로 한 틱 미룬다. */
    if ((e.isComposing || e.keyCode === 229) && box && box.addEventListener) {
      if (askPending === box) return;
      // 다른 칸으로 옮겨 가며 눌렀으면 먼저 예약한 것은 취소된다.
      // 플래그 하나로 잠그면 조합이 끝나지 않은 칸 하나가 단축키 전체를 막는다
      askPending = box;
      box.addEventListener('compositionend', () => {
        if (askPending !== box) return;
        askPending = null;
        setTimeout(() => askByKey(box), 0);
      }, { once: true });
      box.addEventListener('blur', () => { if (askPending === box) askPending = null; }, { once: true });
      return;
    }

    e.preventDefault();
    askByKey(box);
    return;
  }

  if (cmd && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    openFind();
    return;
  }

  if (cmd && e.key === '.') {
    e.preventDefault();
    drop.focus();
    return;
  }

  if (e.key === 'Escape') {
    if (picked) { picked = null; render(); }
  }
});

function saveFile() {
  const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `판-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
}
$('#btn-export').addEventListener('click', saveFile);
$('#btn-find').addEventListener('click', openFind);

/* 저장이 멈춘 사실을 화면에 계속 표시한다.

   경고창 한 번으로 끝내면 그것을 닫은 뒤 화면은 정상으로 보이고 편집 함수는 계속
 메모리를 바꾸므로, 그 뒤에 적은 것이 새로고침에서 모두 사라진다.
   그래서 멈춘 사실을 띠로 표시하고, 새로고침 전에 현재 내용을 꺼내는 수단을 같은
   자리에 둔다. 이 띠는 닫을 수 없다. 닫을 수 있으면 표시하지 않는 것과 같다. */
function stopBar(why) {
  if ($('#stopbar')) return;
  document.body.prepend(el('div', { id: 'stopbar' },
    el('b', {}, '저장 멈춤'),
    el('span', {}, why),
    el('span', { class: 'act' }, '지금 것을 파일로 내려받은 뒤 새로고침'),
    el('button', { class: 'ghost sm', onclick: saveFile }, '파일로 내려받기')));
}
Store.onStop(stopBar);
if (Store.stopped()) stopBar(Store.stopped());
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { Store.importJSON(r.result); render(); }
    catch (err) { alert('불러오기 실패: ' + err.message); }
  };
  r.readAsText(f);
});

/* 서버에서 판을 받아 온 뒤에 그린다. 곧바로 그리면 빈 판이 한 번 번쩍이고,
   그 사이에 사람이 한 줄이라도 적으면 받아 온 것이 그것을 지운다. */
Store.onRemote(() => { picked = null; render(); });
Store.ready.then(() => { paintFold(!!Store.ui('railFolded')); render(); input.focus(); });
