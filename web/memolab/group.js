/* 묶기. 판 목록을 무엇으로 나눌 것인가.

   소유 범위
     판의 날짜가 무엇인가, 그 날짜를 사람에게 어떻게 표시할 것인가, 그리고 판 목록을
     폴더 또는 날짜로 나눈 결과.

   제공 API
     boardDay(board) · dayLabel(day, now) · railGroups(boards, by, inboxId) · mergeFolder(dropFolder, used).

   의존 대상
     아무것도 import 하지 않는다. DOM 도 Store 도 참조하지 않는다. 판 목록을 주면 나눈 결과를
     돌려주는 순수 계산이라 앱 없이도 호출할 수 있다(bin/memolab-groups.mjs).
     지금 시각도 인자로 받는다. 안에서 새 Date 를 만들면 검사가 날짜를 고정할 수 없다.

   유지 조건
     날짜는 마지막으로 적은 날이다. 만든 날로 묶으면 닷새에 걸쳐 쌓은 판이 첫날 하나에
     모여서, 어제 이어 적은 것을 어제 자리에서 찾을 수 없다.
     보관함은 어느 묶음에도 들어가지 않는다. 받아두는 곳이라 어느 묶음을 접어도 접근할 수 있어야 한다.
     묶음 순서는 최근이 위다. 폴더를 이름순으로 세우면 최근에 쓰는 폴더가 아래로 밀린다.

   영향 범위
     app.js 의 renderRail 과 bin/memolab-groups.mjs.
*/

/* 판을 판 위에 겹쳤을 때 어느 폴더로 묶이는가.

   받는 판에 폴더가 있으면 그 폴더로 들어간다. 새로 만들면 같은 일이 폴더 둘로 갈린다.
   받는 판도 폴더가 없으면 새 이름을 짓는다. 쓰고 있는 이름과 겹치면 두 묶음이 하나로
   합쳐지므로, 사용하지 않는 이름이 나올 때까지 뒤에 수를 붙인다.

   이름은 나중에 고친다. 겹치는 순간에 이름부터 물으면 옮기는 동작이 끊긴다. */
export function mergeFolder(dropFolder, used) {
  const has = String(dropFolder || '').trim();
  if (has) return { name: has, fresh: false };
  const taken = new Set(used || []);
  if (!taken.has('새 폴더')) return { name: '새 폴더', fresh: true };
  for (let n = 2; ; n += 1) {
    const name = `새 폴더 ${n}`;
    if (!taken.has(name)) return { name, fresh: true };
  }
}

/* 판의 날짜. 아직 아무것도 적지 않은 판은 마지막으로 적은 날이 없어 만든 날을 쓴다. */
export function boardDay(b) {
  let last = '';
  for (const p of b.pieces || []) if (p.at && p.at > last) last = p.at;
  return (last || b.created || '').slice(0, 10);
}

// 오늘·어제만 이름으로 표시한다. 날짜를 읽지 않고도 알 수 있는 것은 그 둘뿐이다
export function dayLabel(day, now) {
  if (!day) return '날짜 없음';
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = day.split('-').map(Number);
  const gap = Math.round((t - new Date(y, m - 1, d)) / 86400000);
  if (gap === 0) return '오늘';
  if (gap === 1) return '어제';
  return (y === now.getFullYear() ? '' : `${y}년 `) + `${m}월 ${d}일`;
}

/* 판 목록을 나눈다.

   돌려주는 것
     inbox  보관함 하나. 묶음 밖에 둔다
     flat   묶지 않고 그대로 나열할 판. 폴더가 하나도 없을 때만 채워진다
     groups [{ key, label, rows }] 묶음. 최근이 위다

   폴더가 하나도 없는데 폴더로 묶으면 「폴더 없음」 하나만 있는 화면이 된다. 그것은
   묶음이 아니라 목록에 머리글 하나가 붙은 것이므로, 그때는 묶지 않는다. */
export function railGroups(boards, by, inboxId, now = new Date()) {
  const inbox = boards.find((b) => b.id === inboxId) || null;
  const rest = boards.filter((b) => b.id !== inboxId);
  const anyFolder = rest.some((b) => (b.folder || '').trim());

  if (by !== 'date' && !anyFolder) return { inbox, flat: rest, groups: [] };

  const bucket = new Map();
  for (const b of rest) {
    const key = by === 'date' ? boardDay(b) : (b.folder || '').trim();
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(b);
  }

  const newest = (rows) => rows.reduce((mx, b) => (boardDay(b) > mx ? boardDay(b) : mx), '');
  const keys = [...bucket.keys()].sort((a, c) => {
    // 폴더 없음은 늘 맨 아래다. 사람이 정한 묶음이 먼저다
    if (by !== 'date' && !a !== !c) return a ? -1 : 1;
    return newest(bucket.get(c)).localeCompare(newest(bucket.get(a)));
  });

  const groups = keys.map((key) => ({
    key: `${by}|${key}`,
    label: by === 'date' ? dayLabel(key, now) : (key || '폴더 없음'),
    rows: bucket.get(key).slice().sort((a, c) => boardDay(c).localeCompare(boardDay(a))),
  }));
  return { inbox, flat: null, groups };
}
