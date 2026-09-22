/* 저장 계층. 서버 한 파일.

   정본은 Iris 서버의 /memolab-state 하나이고 파일은 ~/.iris/memolab.json 이다.
   브라우저 localStorage 를 쓰면 주소가 조금만 달라도(localhost 와 127.0.0.1) 다른 판이
   열리고, 기기를 옮기면 아무것도 남지 않는다.

   바깥에 보이는 API 는 전부 동기다. 처음 한 번만 서버에서 받아 오고(ready), 그 뒤로는
   메모리에 있는 것을 읽는다. 쓰기는 모아서 보낸다.
   그러지 않으면 조각 하나 옮길 때마다 판 전체가 왕복한다.

   판 하나의 형태는 보기가 달라도 같다. 조각은 한 번만 만들고, 보기는 갈아 끼운다.
   place가 보기마다 따로 있어서 보기를 바꿔도 앞서 놓은 배치가 사라지지 않는다.

   판에는 두 가지가 붙는다.
   - kind(상황): 이 판이 무엇을 하는 곳인가. 회의·공부·할 일…  칸의 이름을 정한다.
   - view(보기): 같은 조각을 어떤 기준으로 보는가. 칸·줄·나무·이음.
   둘을 한 줄에 늘어놓으면 "회의"와 "흐름"이 같은 층위로 보이지만 실제로는 다르다.
   place 의 키는 둘을 합친 frame 이고 이전 값과 같은 문자열이라 기존 판도 그대로 열린다. */

export const Store = (() => {
  const INBOX = 'inbox';

  /* 이전 판 복원. 이전 형식은 frame 하나에 상황과 보기가 섞여 있었고 줄·나무만 보기였다.
     place 키는 바꾸지 않는다.

     이 셋은 load() 위에 있어야 한다. load() 는 첫 줄에서 곧바로 호출되는데
     const 는 함수 선언과 달리 호이스팅되지 않아, 아래에 두면 판을 읽는 도중 오류가 난다
 (확인 결과: 아래에 두자 저장된 판 셋이 화면에서 하나로 줄었다).*/
  const KIND_SET = ['group', 'quad', 'todo', 'prep', 'study', 'meet'];
  const VIEW_OF = { flow: 'line', tree: 'tree', link: 'link' };
  /* 보기 → place 키. 표는 여기 하나이고 화면은 Store.FRAME_OF 를 받아 쓴다.
     화면에만 보기를 추가하면 판을 다시 열 때 migrate 가 frame 을 undefined 로 만들어
     다른 칸이 열린다. */
  const FRAME_OF = { line: 'flow', tree: 'tree', link: 'link', word: 'word' };

  function migrate(b) {
    /* 판이 든 폴더. 이름 자체가 폴더이고 폴더 목록을 따로 두지 않는다.

       목록을 따로 두면 판이 모두 빠져나간 빈 폴더가 남고, 그것을 지우고 이름을 고치고
       순서를 정하는 처리가 함께 필요해진다. 이름으로 묶으면 마지막 판이 나가는 순간
       폴더도 사라져 정리할 대상이 생기지 않는다.
       대신 폴더 이름을 바꾸는 것은 그 안의 판을 전부 고치는 일이다. */
    b.folder = typeof b.folder === 'string' ? b.folder.trim() : '';
    b.place = b.place || {};
    /* 이름 없는 배치 항목을 정리한다. 분류 이름이 undefined 인 채로 만들어진 항목은
       아무것도 담고 있지 않으면서 「쓰인 분류」 개수에 하나씩 더해진다. 빈 것만 지운다. */
    if (b.place.undefined && !Object.keys(b.place.undefined).length) delete b.place.undefined;
    b.cfg = b.cfg || {};
    b.pieces = b.pieces || [];
    b.links = b.links || [];
    // 지도에서 사람이 직접 옮겨 둔 위치. 가운데를 0,0 으로 본 값이다
    b.map = b.map || {};
    /* 칸 안의 순서. 분류마다 따로 둔다.

       조각에 p.ord 하나로 붙이면 배치는 분류마다 따로인데 순서만 공유하게 되어,
       공부에서 순서를 바꾸면 회의의 순서까지 함께 움직인다. 이전 값은 지우지 않는다.
       아직 이 표에 없는 조각은 p.ord 를 그대로 읽는다. */
    b.order = b.order || {};
    if (!('star' in b)) b.star = null;
    if (!b.kind || !b.view) {
      const f = b.frame || 'group';
      b.view = VIEW_OF[f] || 'box';
      b.kind = KIND_SET.includes(f) ? f : 'group';
    }
    /* 모르는 보기를 만나도 frame 이 비지 않는다. undefined 가 되면 place 키가 사라져
       다른 칸이 열리고, 새 보기를 쓰던 판을 이전 화면으로 열 때 그 상황이 생긴다. */
    b.frame = b.view === 'box' ? b.kind : (FRAME_OF[b.view] || b.kind || 'group');
    // 지금 어디를 보고 있는가. 이전 형식에서는 공부 설정 안에만 있었다(cfg.study.loc)
    if (typeof b.at !== 'string') b.at = (((b.cfg || {}).study) || {}).loc || '';
    return b;
  }

  /* 저장 형식의 버전. 값을 늘리기 위한 것이 아니라 이 파일이 어느 형식으로 쓰였는지를
     기록한다. 모르는 번호를 만나면 화면이 그 사실을 알 수 있어야 한다. */
  const SCHEMA = 1;

  const URL_STATE = '/memolab-state';
  // 화면 상태는 다른 파일이다. 바뀌는 단위가 달라서 rev 도 충돌 판정도 따로 둔다
  const URL_UI = '/memolab-ui';

  let state = seed();   // 서버에서 받아 오기 전까지의 빈 판. ready 가 이것을 갈아 끼운다

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function blankBoard(over = {}) {
    return {
      id: uid(),
      title: '',
      created: new Date().toISOString(),
      kind: 'group',
      view: 'box',
      frame: 'group',
      star: null,
      at: '',
      pieces: [],
      place: {},
      links: [],
      cfg: {},
      ...over,
    };
  }

  function seed() {
    return {
      boards: [
        blankBoard({
          id: INBOX,
          title: '보관함',
          frame: 'group',
        }),
      ],
      v: SCHEMA,
    };
  }

  /* 이전 판 문서에 남아 있던 창 상태. 읽기만 하고 다시 쓰지 않는다.

     이 객체를 state 에 그대로 담으면 view.ui 와 판 문서의 ui 가 같은 객체를 가리켜,
     배율 하나만 바꿔도 판 문서가 함께 바뀌고 다음 저장이 그것을 판에 실어 보낸다.
     확인 결과: 판 문서와 창 상태 파일에 allTabs·mapZoom 이 같은 값으로 둘 다 있었다.
     그래서 여기서 받아 두고 state 에는 넣지 않는다. 넘길 때는 복사해서 넘긴다. */
  let legacy = { ui: null, current: '' };

  function adopt(p) {
    if (!p || !Array.isArray(p.boards) || !p.boards.length) return seed();
    if (!p.boards.some((b) => b.id === INBOX)) {
      p.boards.unshift(blankBoard({ id: INBOX, title: '보관함' }));
    }
    /* 이전 이름을 쓰던 문서를 새 이름으로 옮긴다. 이 판의 이름은 코드가 아니라 문서에
       담겨 있어서, 코드만 고치면 이미 쓰던 화면에는 이전 이름이 그대로 남는다.
       이전 이름 하나만 대상으로 하고, 사람이 직접 붙인 이름은 바꾸지 않는다. */
    const box = p.boards.find((b) => b.id === INBOX);
    if (box && box.title === '흘림함') box.title = '보관함';
    for (const b of p.boards) migrate(b);
    legacy = {
      ui: p.ui && typeof p.ui === 'object' && !Array.isArray(p.ui) ? p.ui : null,
      current: typeof p.current === 'string' ? p.current : '',
    };
    return { boards: p.boards, v: SCHEMA };
  }

  /* 창 상태. 판과 다른 파일에 담는다.

     배율·접힘·지금 연 판을 판 문서에 두면 마인드맵 배율만 바꿔도 조각 전체가 다시
     올라가고, 두 창이 서로 다른 판을 볼 때 저장이 충돌해 한쪽이 멈추며, 다른 창이
     판을 옮기면 이 창까지 따라간다. 바뀌는 단위가 다르면 저장 위치도 나눈다.

     여기에는 충돌 판정도 수신도 없다. 나중에 저장한 쪽이 남는다. 창 설정이 한쪽으로
     정해지는 것은 손실이 아니고, 그 대신 판 저장이 막히지 않는다. */
  let view = { ui: {}, current: INBOX };
  let viewTimer = null;

  async function pushView() {
    try {
      await fetch(URL_UI, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(view),
      });
    } catch (e) { /* 창 설정은 다음 편집 때 다시 올라간다. 여기서 저장을 중단하지 않는다 */ }
  }

  function keepView() {
    if (viewTimer) clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { viewTimer = null; pushView(); }, 600);
  }

  let broken = false;   // 못 읽은 판 위에 덮어쓰지 않는다
  let rev = null;       // 서버가 마지막으로 준 판 번호
  let timer = null;
  let sending = false;
  let dirty = false;
  /* 받아 오는 사이에 사람이 편집했는가.

     dirty 만으로는 부족하다. 요청이 도는 동안 편집과 저장이 모두 끝나면 dirty 가 다시
     false 라서 받아 온 내용이 그 편집을 지운다. 이때 rev 도 새 값으로 바뀌므로 서버의
     409 도 막지 못한다.

     그래서 요청을 시작한 시점의 rev 를 보관했다가 응답이 왔을 때 대조한다. 그 사이에
     저장이 끝났으면 rev 가 이미 다른 값이다. dirty · sending · broken 과 함께 하나의
     방어 조건이고, 하나만으로는 서로를 덮는다. 검사 1·2 는 이 줄을 지우면 실패한다. */
  let onRemote = null;  // 다른 곳에서 바뀐 것을 받아 왔을 때 화면을 다시 그리는 콜백

  /* 저장을 멈춘다. 한 번만 알리고 그 뒤로는 아무것도 보내지 않는다.

     편집 함수는 그 뒤에도 메모리를 계속 바꾼다. 경고창을 닫으면 화면은 정상으로 보이고
     사람은 계속 적지만, 그 내용은 새로고침에서 모두 사라진다. 그래서 멈춘 사실을 화면이
     계속 표시해야 하고, 새로고침 전에 현재 내용을 꺼낼 수단이 있어야 한다.
     화면은 onStop 으로 그 표시를 세운다. */
  let onStop = null;
  let stopWhy = '';

  function stop(why) {
    if (broken) return;
    broken = true;
    stopWhy = why;
    if (timer) { clearTimeout(timer); timer = null; }
    if (onStop) onStop(why);
    alert(why + '\n덮어쓰기 방지로 저장 중단. 지금 것을 파일로 내려받은 뒤 새로고침.');
  }

  async function pull() {
    const r = await fetch(URL_STATE, { cache: 'no-store' });
    if (!r.ok) throw new Error('서버 응답 ' + r.status);
    return r.json();
  }

  /* 처음 한 번. 서버에 아무것도 없으면 지금 것을 그대로 올려 파일을 만든다.
     여기서 실패하면 빈 판으로 시작하지 않는다. 그 빈 판이 다음 저장에서 원본을 덮는다. */
  const ready = (async () => {
    try {
      const j = await pull();
      rev = j.rev;
      state = j.data ? adopt(j.data) : state;
      if (!j.data) await push();
      /* 창 상태를 따로 읽는다. 아직 그 파일이 없으면 판 문서에 남아 있던 이전 값을
         그대로 물려받아, 접힘 상태와 열어 둔 판을 잃지 않게 한다. */
      let got = null;
      try {
        const r = await fetch(URL_UI, { cache: 'no-store' });
        if (r.ok) got = await r.json();
      } catch (e) { got = null; }
      const has = got && got.ui && Object.keys(got.ui).length;
      view = {
        ui: has ? got.ui : { ...(legacy.ui || {}) },
        current: (got && got.current) || legacy.current || INBOX,
      };
      if (!has) keepView();
    } catch (e) {
      console.error('판 읽기 실패', e);
      stop('판 읽기 실패 — ' + e.message);
    }
    return state;
  })();

  async function push() {
    if (broken || sending) return;
    sending = true;
    dirty = false;
    try {
      const r = await fetch(URL_STATE, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev, data: state }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) {
        stop('다른 곳에서 이 판을 먼저 바꿈.');
      } else if (!r.ok) {
        stop('저장 실패 — 서버 응답 ' + r.status);
      } else {
        rev = j.rev;
      }
    } catch (e) {
      stop('저장 실패 — ' + e.message);
    } finally {
      sending = false;
      // 보내는 동안 또 바뀌었으면 한 번 더 보낸다. 그러지 않으면 마지막 편집이 올라가지 않는다
      if (dirty && !broken) persist();
    }
  }

  function persist() {
    if (broken) return;
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; push(); }, 400);
  }

  /* 다른 기기·다른 탭에서 바뀐 것을 받아 온다. 이것이 없으면 어디서 접속해도 같다는 조건이
     연 순간에만 성립하고 그 뒤로는 창마다 다른 내용을 보게 된다. 보낼 것이 남아 있으면
     건너뛴다. 받아 오는 순간 이 창의 편집이 사라지기 때문이다. */
  async function poll() {
    if (broken || dirty || sending || rev == null) return;
    const atRev = rev;
    try {
      const r = await fetch(`${URL_STATE}?rev=${rev}`, { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j.same || j.rev === rev) return;
      /* 요청을 시작한 뒤 이 창에서 무엇이든 바뀌었으면 받아 온 것을 버린다. 지금 화면이
         편집 내용을 갖고 있고, 그것을 덮으면 알림 없이 손실된다.
         다음 차례에 다시 요청하며, 그때는 그 편집이 이미 올라가 있다. */
      if (rev !== atRev || dirty || sending || broken) return;
      rev = j.rev;
      state = adopt(j.data);
      if (onRemote) onRemote();
    } catch (e) { /* 잠깐 끊긴 것으로 본다. 다음 차례에 다시 묻는다 */ }
  }
  setInterval(poll, 10000);
  // 다른 창을 보다 돌아오면 즉시 한 번 더 요청한다. 10초를 기다리지 않는다
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  const boards = () => state.boards;
  const current = () => state.boards.find((b) => b.id === view.current) || state.boards[0];
  const inbox = () => state.boards.find((b) => b.id === INBOX);

  function open(id) {
    if (state.boards.some((b) => b.id === id)) { view.current = id; keepView(); }
  }

  function addBoard(over) {
    const b = blankBoard(over);
    state.boards.push(b);
    view.current = b.id;
    keepView();
    persist();
    return b;
  }

  function removeBoard(id) {
    if (id === INBOX) return;
    state.boards = state.boards.filter((b) => b.id !== id);
    if (view.current === id) { view.current = INBOX; keepView(); }
    persist();
  }

  function patchBoard(id, patch) {
    const b = state.boards.find((x) => x.id === id);
    if (!b) return null;
    Object.assign(b, patch);
    persist();
    return b;
  }

  /* --- 조각 --- */

  function addPiece(boardId, text) {
    const b = state.boards.find((x) => x.id === boardId);
    const t = (text || '').trim();
    if (!b || !t) return null;
    const p = { id: uid(), text: t, at: new Date().toISOString() };
    b.pieces.unshift(p);
    persist();
    return p;
  }

  function editPiece(boardId, pieceId, text) {
    const b = state.boards.find((x) => x.id === boardId);
    const p = b && b.pieces.find((x) => x.id === pieceId);
    if (!p) return;
    p.text = text;
    persist();
  }

  /* 조각에 붙는 값(대분류·날짜·시각). 프레임이 아니라 조각의 속성이라
     프레임을 바꿔도 남는다. 할 일 프레임에서만 편집 화면을 연다. */
  function setMeta(boardId, pieceId, patch) {
    const b = state.boards.find((x) => x.id === boardId);
    const p = b && b.pieces.find((x) => x.id === pieceId);
    if (!p) return;
    Object.assign(p, patch);
    persist();
  }

  /* 조각을 지운다. 그 조각을 가리키던 것까지 함께 지운다.

     갈래에서는 칸 이름이 부모 조각의 id 다. 부모만 지우면 자식의 배치가 없는 부모를
     가리킨 채 남고, 갈래는 뿌리부터 그리고 더미는 배치가 있는 것을 제외하므로 그 자식이
     양쪽 어디에도 보이지 않는다. 키로 지우는 것만으로는 부족해 값으로 가리키는 것도 본다. */
  function removePiece(boardId, pieceId) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    b.pieces = b.pieces.filter((p) => p.id !== pieceId);
    for (const f of Object.keys(b.place)) {
      delete b.place[f][pieceId];
      for (const [k, v] of Object.entries(b.place[f])) {
        if (v === pieceId) delete b.place[f][k];
      }
    }
    if (b.map) delete b.map[pieceId];
    b.links = (b.links || []).filter((l) => l.a !== pieceId && l.z !== pieceId);
    if (b.star === pieceId) b.star = null;
    persist();
  }

  /* 판이 달라도 뜻이 같은 칸. 여기 있던 것은 옮겨도 같은 칸에 들어간다.
     묶음·흐름·갈래의 칸은 판마다 이름이 달라서 따라가지 않는다. */
  const FIXED = {
    meet: ['heard', 'decided', 'todo', 'open'],
    prep: ['result', 'say', 'ask', 'park'],
    study: ['quote', 'mine', 'ask', 'use'],
    todo: ['now', 'wait', 'some', 'done'],
    quad: ['lh', 'hh', 'll', 'hl'],
  };

  /* 판에서 판으로 넘기기. 이동이 아니라 복사다.

     회의록의 할 것을 할 일 판으로 이동하면 회의록에서 그 줄이 사라진다. 회의록은 기록이라
     그대로 남아야 하고 할 일 판은 그것을 자기 항목으로 다루므로, 이동하지 않고 복사한다.

     복사한 조각은 src 에 원본 id 를 남긴다. 같은 것을 두 번 눌러도 두 번 들어가지 않는다. */
  const CARRY = ['cat', 'due', 'mins', 'loc', 'owner', 'why', 'said'];

  function copyPieces(fromId, toId, pieceIds) {
    const from = state.boards.find((x) => x.id === fromId);
    const to = state.boards.find((x) => x.id === toId);
    if (!from || !to) return 0;
    const already = new Set(to.pieces.map((p) => p.src).filter(Boolean));
    const want = new Set(pieceIds);
    const rows = from.pieces.filter((p) => want.has(p.id) && !already.has(p.id));
    rows.forEach((p) => {
      const made = { id: uid(), text: p.text, at: new Date().toISOString(), src: p.id };
      CARRY.forEach((k) => { if (p[k]) made[k] = p[k]; });
      to.pieces.unshift(made);
    });
    if (rows.length) persist();
    return rows.length;
  }

  function movePieces(fromId, toId, pieceIds) {
    const from = state.boards.find((x) => x.id === fromId);
    const to = state.boards.find((x) => x.id === toId);
    if (!from || !to) return;
    const set = new Set(pieceIds);
    const moving = from.pieces.filter((p) => set.has(p.id));
    from.pieces = from.pieces.filter((p) => !set.has(p.id));
    for (const f of Object.keys(from.place)) {
      const keep = FIXED[f] || [];
      for (const id of set) {
        const slot = from.place[f][id];
        if (slot && keep.includes(slot)) {
          to.place[f] = to.place[f] || {};
          to.place[f][id] = slot;
        }
        delete from.place[f][id];
      }
    }
    // 이음은 판 안에서만 성립한다. 조각이 빠지면 그 조각에 걸린 선도 함께 지운다
    from.links = (from.links || []).filter((l) => !set.has(l.a) && !set.has(l.z));
    if (set.has(from.star)) from.star = null;
    to.pieces.unshift(...moving);
    persist();
  }

  /* --- 배치 --- */

  function slots(board, frame) {
    board.place[frame] = board.place[frame] || {};
    return board.place[frame];
  }

  /* 조각을 칸에 놓는다. 놓는 처리와 그에 딸린 후속 처리를 같은 함수에 둔다.

     화면이 put 을 부른 뒤 afterPut 을 따로 부르는 구조에서는 호출 지점이 열여덟 곳이라
     일부가 빠진다. 실제로 더미로 뺀 조각에 의문 표시가 남고, ⌘⇧Enter 로 바로 넣은
     조각에는 의문 표시가 붙지 않았다. 호출 지점은 경로가 늘 때마다 다시 빠지므로
     이 함수 안에서 처리한다.

     의문은 들어오고 나가는 경계에서만 바꾼다. 의문 칸으로 들어오면 세우고 나가면 내린다.
     그 밖의 칸끼리 옮기는 것은 의문 여부와 무관하다. 정한 것에 있는 카드를 ⌘/ 로 의문으로
     세워 둘 수 있어야 하고, 그것을 할 것으로 옮겼다고 해제되면 안 된다. */
  function put(boardId, frame, pieceId, slot) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    const s = slots(b, frame);
    const prev = s[pieceId];
    if (slot === null) delete s[pieceId];
    else s[pieceId] = slot;
    if (slot !== prev) {
      const piece = b.pieces.find((x) => x.id === pieceId);
      if (piece) {
        if (slot === 'ask') { piece.q = true; piece.from = b.id; }
        else if (prev === 'ask') { piece.q = false; }
      }
    }
    persist();
  }

  /* 칸 안의 순서. 분류마다 따로 센다. 아직 이 표에 없는 조각은 이전 p.ord 를 그대로 읽어,
     쓰던 판을 열어도 순서가 유지된다. */
  function orderOf(b, frame, pieceId) {
    const own = ((b.order || {})[frame] || {})[pieceId];
    if (typeof own === 'number') return own;
    const p = (b.pieces || []).find((x) => x.id === pieceId);
    return p && typeof p.ord === 'number' ? p.ord : Infinity;
  }

  function setOrder(boardId, frame, seq) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    b.order = b.order || {};
    b.order[frame] = b.order[frame] || {};
    seq.forEach((pieceId, i) => { b.order[frame][pieceId] = i; });
    persist();
  }

  /* --- 이음 ---

     선의 뜻은 셋뿐이다. 넷째를 만들고 싶으면 그 전에 셋으로 못 적는지 먼저 본다.
     같은 두 조각 사이에는 선이 하나만 있고, 뜻을 바꾸면 덮어쓴다. */
  const LINK_KINDS = ['cause', 'block', 'same'];

  function links(board) { return board.links || (board.links = []); }

  function link(boardId, a, z, k) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b || !a || !z || a === z) return;
    const ls = links(b);
    const at = ls.findIndex((l) => (l.a === a && l.z === z) || (l.a === z && l.z === a));
    if (at >= 0) ls[at] = { a, z, k };
    else ls.push({ a, z, k });
    persist();
  }

  function unlink(boardId, a, z) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    b.links = links(b).filter((l) => !((l.a === a && l.z === z) || (l.a === z && l.z === a)));
    persist();
  }

  /* 선을 누를 때마다 뜻이 한 칸씩 바뀌고, 마지막에서 한 번 더 누르면 끊긴다.
     지우는 단추를 따로 두면 선마다 단추가 붙어 그림이 가려진다. */
  function cycleLink(boardId, a, z) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    const cur = links(b).find((l) => (l.a === a && l.z === z) || (l.a === z && l.z === a));
    if (!cur) return link(boardId, a, z, 'cause');
    const i = LINK_KINDS.indexOf(cur.k);
    if (i < 0 || i === LINK_KINDS.length - 1) return unlink(boardId, cur.a, cur.z);
    link(boardId, cur.a, cur.z, LINK_KINDS[i + 1]);
  }

  // 화살표를 거꾸로. 원인과 결과를 잘못 이었을 때 지웠다 다시 잇지 않게
  function flipLink(boardId, a, z) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    const cur = links(b).find((l) => (l.a === a && l.z === z) || (l.a === z && l.z === a));
    if (!cur) return;
    const t = cur.a; cur.a = cur.z; cur.z = t;
    persist();
  }

  /* 지도에서 사람이 옮겨 둔 위치.

     키는 조각이면 그 id, 가지면 `w:낱말` 이다. 값은 가운데를 0,0 으로 본 x·y 이고,
     화면 좌표로 담으면 창 크기나 다른 조각이 바뀔 때마다 어긋난다.
     사람이 옮긴 위치는 자동 계산이 다시 정하지 않는다. */
  function mapAt(boardId, key, xy) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return undefined;
    b.map = b.map || {};
    if (xy === undefined) return b.map[key];
    if (xy === null) delete b.map[key];
    else b.map[key] = { x: Math.round(xy.x), y: Math.round(xy.y) };
    persist();
    return b.map[key];
  }

  function mapReset(boardId) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    b.map = {};
    persist();
  }

  function star(boardId, pieceId) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    b.star = b.star === pieceId ? null : pieceId;
    persist();
  }

  function cfg(boardId, frame, patch) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    b.cfg[frame] = { ...(b.cfg[frame] || {}), ...patch };
    persist();
  }

  /* 판을 폴더에 넣는다. 빈 이름이면 폴더에서 뺀다. */
  function setFolder(boardId, name) {
    const b = state.boards.find((x) => x.id === boardId);
    if (!b) return;
    b.folder = String(name || '').trim();
    persist();
  }

  /* 폴더 이름 바꾸기. 폴더는 판이 들고 있는 이름 하나라서, 바꾸려면 그 이름을 든 판을
     전부 같이 바꿔야 한다. 한 판만 바꾸면 그 판이 폴더에서 떨어져 나간다.
     빈 이름으로 바꾸면 그 폴더가 해제되어 판은 남고 묶음만 사라진다. */
  function renameFolder(from, to) {
    const a = String(from || '').trim();
    const z = String(to || '').trim();
    if (!a || a === z) return;
    let hit = 0;
    for (const b of state.boards) if ((b.folder || '').trim() === a) { b.folder = z; hit += 1; }
    if (hit) persist();
  }

  // 지금 쓰이고 있는 폴더 이름. 따로 저장하지 않고 판에서 계산한다
  function folders() {
    const seen = new Set();
    for (const b of state.boards) if (b.folder) seen.add(b.folder);
    return [...seen].sort((a, c) => a.localeCompare(c));
  }

  /* --- 반출입 --- */

  /* 화면 설정(ui)은 내보내기에 넣지 않는다. 내보내기는 판을 전달하는 것이고
     창이 접혀 있었는지는 전달 대상이 아니다. */
  function exportJSON() {
    return JSON.stringify({ boards: state.boards, current: view.current }, null, 2);
  }

  /* 판 데이터가 아닌 화면 설정. 브라우저 저장소를 쓰지 않고 여기 담으므로,
     주소가 달라도(localhost 와 127.0.0.1) 같은 상태가 되고 기기를 옮겨도 유지된다. */
  function ui(key, val) {
    if (val === undefined) return view.ui[key];
    view.ui[key] = val;
    keepView();
    return val;
  }

  /* 불러오기. 전부 검증한 뒤에 한 번에 교체한다.

     state 를 먼저 대입하고 판을 검사하면, 중간에 잘못된 판을 만나 오류를 내는 시점에는
     이미 기존 판을 지운 뒤이고 다음 저장이 그 일부만 서버로 올린다.
     그래서 검증을 채택보다 먼저 한다. */
  function importJSON(text) {
    const p = JSON.parse(text);
    if (!Array.isArray(p.boards) || !p.boards.length) throw new Error('boards 배열 없음');
    const boards = p.boards.map((b) => {
      if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !b.id) {
        throw new Error('판에 id 가 없음');
      }
      if (b.pieces !== undefined && !Array.isArray(b.pieces)) throw new Error('pieces 가 배열이 아님');
      return migrate({ ...b });
    });
    if (!boards.some((b) => b.id === INBOX)) {
      boards.unshift(migrate(blankBoard({ id: INBOX, title: '보관함' })));
    }
    const cur = boards.some((b) => b.id === p.current) ? p.current : boards[0].id;
    // 화면 설정은 불러오는 파일에서 받지 않고 이 기기에서 쓰던 것을 유지한다
    state = { boards, v: SCHEMA };
    view.current = cur;
    keepView();
    persist();
  }

  return {
    INBOX, boards, current, inbox, open, addBoard, removeBoard, patchBoard,
    ready, onRemote: (fn) => { onRemote = fn; },
    stopped: () => (broken ? stopWhy : ''), onStop: (fn) => { onStop = fn; },
    addPiece, editPiece, removePiece, movePieces, copyPieces, setMeta,
    slots, put, orderOf, setOrder, star, cfg, ui, mapAt, mapReset, exportJSON, importJSON,
    setFolder, renameFolder, folders,
    links, link, unlink, cycleLink, flipLink, migrate, LINK_KINDS, FRAME_OF,
  };
})();
