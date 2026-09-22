/* 낱말. 조각 글에서 가지를 뽑는다.

   소유 범위
     한국어·영문이 섞인 한 줄에서 단어를 뽑는 규칙과, 그 단어로 가지를 만드는 계산.
     그리고 사람이 고쳐 둔 것(뺀 말·합친 말·붙인 이름·고정)을 그 계산에 반영한다.

   제공 API
     wordsOf(text) · wordCfg(board) · wordMap(board). 그 밖의 것은 없다.

   의존 대상
     아무것도 import 하지 않는다. DOM 도 Store 도 참조하지 않는다. 판 하나를 주면 값을 돌려주는
     순수 계산이라 앱 없이도 호출할 수 있다(bin/memolab-words.mjs).

   유지 조건
     사람이 고친 것은 단어에 매단다. 걸린 조각 목록에 매달면 조각 한 장만 늘어도
     키가 바뀌어 사람이 정한 것이 재계산에서 사라진다.

   영향 범위
     app.js 의 마인드맵 화면과 bin/memolab-words.mjs.
*/

/* ---------- 낱말 ----------

   칸도 선도 사람이 직접 정하는 방식은 조각이 스물을 넘으면 작업량 자체가 부담이 되어,
   적어 두기만 하고 아무 모양도 만들지 않은 판이 쌓인다. 여기서는 사람이 정하지 않고
   글자만 보고 같은 말이 든 조각끼리 묶는다.

   형태소 분석기가 없어 통째로 같은 말만 세면 「벌점」과 「벌점이」가 다른 말이 되어 아무것도
   묶이지 않는다. 그래서 뒤에 붙는 토씨·어미를 긴 것부터 떼어 본다. 정확하지는 않지만
   틀려도 묶음 하나가 어긋날 뿐이고 사람이 바로 확인할 수 있다.

   두 장 이상에 든 단어만 가지가 된다. 하나에만 있는 말은 묶는 데 쓰이지 않으므로 뺀다. */

// 뒤에 붙는 것. 긴 것부터 떼어야 「으로는」이 「는」으로 먼저 잘리지 않는다
const TAIL = [   // 낱말 데이터
  '으로써', '에게서', '으로는', '이라고', '에서는', '에서도', '으로도',
  '하다가', '했다는', '한다는', '이라는', '라는', '이란',
  '부터', '까지', '에게', '한테', '처럼', '보다', '마다', '마저', '조차', '밖에',
  '으로', '에서', '에는', '이나', '거나', '든지', '지만', '면서', '려고', '도록',
  '하는', '했던', '하던', '한테', '이며', '이고', '이다', '입니', '합니', '습니',
  '들이', '들을', '들은', '들의',
  '은', '는', '이', '가', '을', '를', '의', '에', '도', '만', '과', '와', '로',
  '야', '라', '나', '며', '고', '지', '요', '한', '할', '함', '해', '됨', '된', '될',
];

// 어디에나 나와서 묶어도 구분에 쓸 수 없는 말
const SKIP = new Set([   // 낱말 데이터
  '그리고', '하지만', '그래서', '그런데', '이것', '저것', '그것', '여기', '거기', '저기',
  '때문', '경우', '정도', '자체', '부분', '내용', '상태', '기준', '관련', '대한', '대해',
  '있다', '없다', '같다', '한다', '된다', '싶다', '좋다', '보이', '해야', '해서', '하고',
  '우리', '저희', '이런', '저런', '그런', '어떤', '무슨', '무엇', '누구', '언제', '어디',
  '조금', '많이', '너무', '아주', '매우', '전체', '각각', '모두', '다시', '먼저', '나중',
  '어떻게', '이렇게', '그렇게', '저렇게', '아마', '혹시', '그냥', '아직', '이미', '계속',
  '바로', '진짜', '정말', '역시', '오히려', '만약', '이제', '아무', '점점', '거의',
  // 영문 두 글자를 살리면서 같이 들어오는 것들
  'of', 'to', 'in', 'on', 'at', 'is', 'it', 'be', 'as', 'by', 'or', 'an', 'the', 'and', 'for',
]);

/* 영문에 조사가 붙으면 한 단어가 여럿으로 갈린다.

   「AI가」·「AI는」·「AI를」이 각각 다른 가지가 되므로, 영문과 한글이 붙어 있어도
   경계로 보고 여기서 나눈다.*/
function splitMixed(raw) {
  return raw.replace(/([A-Za-z0-9])([가-힣])/g, '$1 $2').replace(/([가-힣])([A-Za-z0-9])/g, '$1 $2').split(' ');
}

export function wordsOf(text) {
  const out = new Set();
  const runs = String(text).split(/[^0-9A-Za-z가-힣]+/).flatMap(splitMixed);
  for (let raw of runs) {
    if (!raw) continue;
    if (/^[0-9]+$/.test(raw)) continue;                      // 숫자만은 낱말이 아니다
    if (/[A-Za-z]/.test(raw)) {
      const w = raw.toLowerCase();
      // 두 글자 영문도 단어로 센다(ai · ux · seo · geo)
      if (w.length >= 2 && !SKIP.has(w)) out.add(w);
      continue;
    }
    let w = raw;
    for (const t of TAIL) {
      if (w.length - t.length >= 2 && w.endsWith(t)) { w = w.slice(0, -t.length); break; }
    }
    if (w.length >= 2 && !SKIP.has(w)) out.add(w);
  }
  return out;
}

/* 사람이 고쳐 둔 것. 자동으로 뽑은 가지는 후보이고, 무엇이 주제인지는 사람이 정한다.

   자동 결과에는 셋이 섞인다. 찾는 데 쓸 만한 단서, 어디에나 나와서 구분이 안 되는
   말(필요·것을·가장), 같은 뜻인데 갈린 말(ai가·ai는). 이것을 확정된 의미 구조로 다루면
   그 잡음이 그림의 중심이 된다.

   고친 것은 단어에 적는다. 걸린 조각 목록에 적으면 조각 한 장만 늘어도 키가 바뀌어
   사람이 정한 것이 재계산에서 사라진다. */
export function wordCfg(b) {
  const c = b.cfg.word || {};
  return {
    drop: new Set(c.drop || []),      // 뺀 말
    to: c.to || {},                   // 이 말을 저 말로 합친다
    name: c.name || {},               // 보이는 이름
    keep: new Set(c.keep || []),      // 한 장뿐이어도 유지하는 말
  };
}

export function wordMap(b) {
  const cf = wordCfg(b);
  // 합치기가 순환하면 여기서 멈춘다. 서로를 가리켜도 화면은 정상 동작한다
  const canon = (w) => {
    let x = w;
    for (let i = 0; i < 8 && cf.to[x] && cf.to[x] !== x; i += 1) x = cf.to[x];
    return x;
  };

  const by = new Map();
  const raw = new Map();   // 보이는 말 → 사람이 고를 때 쓰는 원래 말
  b.pieces.forEach((p) => {
    wordsOf(p.text).forEach((w0) => {
      if (cf.drop.has(w0)) return;
      const w = canon(w0);
      if (cf.drop.has(w)) return;
      const arr = by.get(w) || [];
      if (!arr.includes(p.id)) arr.push(p.id);
      by.set(w, arr);
      const rs = raw.get(w) || new Set();
      rs.add(w0);
      raw.set(w, rs);
    });
  });
  // 두 장 이상에 든 것만 가지가 된다. 사람이 고정한 말은 한 장이어도 남긴다
  let hubs = [...by.entries()].filter(([w, ids]) => ids.length > 1 || cf.keep.has(w))
    .map(([word, ids]) => ({ word, ids }));

  /* 「벌점」과 「벌점제도」처럼 한쪽이 다른 쪽을 포함하고 걸린 조각도 같으면 한 가지다.
     둘 다 남기면 같은 카드가 두 번 걸려 그림이 두 배로 커진다. */
  hubs.sort((x, y) => y.word.length - x.word.length);
  const keep = [];
  hubs.forEach((h) => {
    const same = keep.find((k) => k.word.includes(h.word)
      && h.ids.every((id) => k.ids.includes(id)));
    if (!same) keep.push(h);
  });

  /* 다른 말인데 걸린 조각이 완전히 같으면 한 가지다.

     「기능 추가」가 든 카드는 「기능」으로도 「추가」로도 같은 결과를 만든다. 둘 다 남기면
     같은 카드가 화면에 두 번 나오고, 가지 수만 늘어 무엇이 실제 덩어리인지 알 수 없다.
     말을 버리지는 않고 한 마디에 나란히 적는다. */
  const merged = [];
  keep.forEach((h) => {
    const key = h.ids.slice().sort().join('|');
    const same = merged.find((m) => m.key === key);
    if (same) same.words.push(h.word);
    else merged.push({ key, words: [h.word], ids: h.ids });
  });
  const out = merged.map((m) => {
    const words = m.words.sort((a, c) => a.length - c.length);
    // 사람이 붙인 이름이 있으면 그것이 이름이다. 없으면 뽑힌 말을 나란히 적는다
    const named = words.map((w) => cf.name[w]).find(Boolean);
    return {
      key: words.slice().sort().join('|'),   // 단어로 만든 키. 조각이 늘어도 바뀌지 않는다
      word: named || words.join(' · '),
      words,
      // 사람이 고를 때 넘길 원래 말. 합치기 전 형태까지 유지해야 되돌릴 수 있다
      raws: [...new Set(words.flatMap((w) => [w, ...(raw.get(w) || [])]))],
      ids: m.ids,
    };
  });

  out.sort((x, y) => y.ids.length - x.ids.length || x.word.localeCompare(y.word));
  const tied = new Set(out.flatMap((h) => h.ids));
  const alone = b.pieces.filter((p) => !tied.has(p.id));
  // 두 가지 이상에 걸린 조각. 주제가 겹치는 지점이다
  const count = new Map();
  out.forEach((h) => h.ids.forEach((id) => count.set(id, (count.get(id) || 0) + 1)));
  return { hubs: out, alone, count };
}
