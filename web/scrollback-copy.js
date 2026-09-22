(function installScrollbackCopy(root) {
  "use strict";

  function charWidth(ch) {
    const c = ch.codePointAt(0);
    if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x1ab0 && c <= 0x1aff)
      || (c >= 0x1dc0 && c <= 0x1dff) || (c >= 0x20d0 && c <= 0x20ff)
      || (c >= 0xfe20 && c <= 0xfe2f)) return 0;
    return ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)) ? 2 : 1;
  }

  // 한 행이 차지하는 컬럼 수. 한글 등 전각은 2칸이라 글자 수로 세면 어긋난다.
  function colWidth(value) {
    let w = 0;
    for (const ch of String(value == null ? "" : value)) w += charWidth(ch);
    return w;
  }

  function sliceColumns(value, from = 0, to = Infinity) {
    const start = Math.max(0, Number.isFinite(from) ? Math.floor(from) : 0);
    const end = Number.isFinite(to) ? Math.max(start, Math.floor(to)) : Infinity;
    let col = 0, out = "";
    for (const ch of String(value || "")) {
      const width = charWidth(ch);
      const next = col + width;
      if (next > start && col < end) out += ch;
      col = next;
      if (col >= end) break;
    }
    return out;
  }

  // Herdr의 pane 경계는 본문과 같은 xterm 행에 그려진다. crop 감지가 한 셀 늦게 갱신돼도
  // 그 Unicode 경계만 제거하고, 터미널 데이터일 수 있는 ASCII `|`와 들여쓰기는 보존한다.
  function terminalContentRow(value) {
    return String(value == null ? "" : value)
      .replace(/^ {0,3}[▕┃▏▐⎸⎹│«»]+/u, "")
      .replace(/[\s▕┃▏▐⎸⎹│«»]+$/u, "");
  }

  function parseRows(text) {
    const rows = String(text == null ? "" : text).split("\n");
    if (rows.length && rows[rows.length - 1] === "") rows.pop();
    return rows.map((row) => row.endsWith("\r") ? row.slice(0, -1) : row);
  }

  function historySnapshot(snapshot, requireRows) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot unavailable");
    if (snapshot.truncated) throw new Error("snapshot truncated");
    const scroll = snapshot.scroll;
    if (!scroll || !Number.isInteger(scroll.offset_from_bottom)
      || !Number.isInteger(scroll.max_offset_from_bottom) || !Number.isInteger(scroll.viewport_rows)
      || scroll.offset_from_bottom < 0 || scroll.max_offset_from_bottom < scroll.offset_from_bottom
      || scroll.viewport_rows <= 0) throw new Error("scroll metadata invalid");
    const rows = requireRows ? parseRows(snapshot.text) : null;
    const totalRows = scroll.max_offset_from_bottom + scroll.viewport_rows;
    if (requireRows && (!rows.length || rows.length > totalRows))
      throw new Error("scrollback range unavailable");
    return { rows, scroll, totalRows };
  }

  // Herdr recent는 바깥 sidebar/divider와 그 여백을 제외한 pane 행만 준다. 따라서 화면 크롭용
  // skip/gutter를 다시 적용하지 않는다. 시작·끝은 각 시점의 scroll metadata를 전체 history 좌표로
  // 바꿔, 드래그 중 새 출력이 생겨도 최초 행이 바닥 기준으로 밀리지 않게 한다.
  function pickHistoryRows(startSnapshot, endSnapshot, startPosition, endPosition, options = {}) {
    const start = historySnapshot(startSnapshot, false);
    const end = historySnapshot(endSnapshot, true);
    if (startSnapshot.target !== endSnapshot.target) throw new Error("pane changed");
    const viewportRows = start.scroll.viewport_rows;
    if (end.scroll.viewport_rows !== viewportRows) throw new Error("viewport geometry changed");
    if (end.scroll.max_offset_from_bottom < start.scroll.max_offset_from_bottom)
      throw new Error("scrollback history changed");

    const point = (snapshot, position) => {
      const row = Number(position && position.row);
      const col = Math.max(0, Math.floor(Number(position && position.col) || 0));
      if (!Number.isInteger(row) || row < 0 || row >= viewportRows) throw new Error("screen row invalid");
      return { absolute: snapshot.scroll.max_offset_from_bottom
        - snapshot.scroll.offset_from_bottom + row, col };
    };
    let a = point(start, startPosition), b = point(end, endPosition);
    if (b.absolute < a.absolute || (b.absolute === a.absolute && b.col < a.col)) [a, b] = [b, a];

    const firstAbsolute = end.totalRows - end.rows.length;
    const from = a.absolute - firstAbsolute, to = b.absolute - firstAbsolute;
    if (from < 0 || to < from || to >= end.rows.length) throw new Error("scrollback range unavailable");
    const contentCols = Math.max(0, Math.floor(Number(options.contentCols) || 0));
    if (!contentCols) throw new Error("pane geometry invalid");
    const rows = end.rows.slice(from, to + 1).map((row) =>
      sliceColumns(row, 0, contentCols).replace(/\s+$/u, ""));
    const firstPrefix = sliceColumns(rows[0], 0, a.col);
    if (rows.length === 1) rows[0] = sliceColumns(rows[0], a.col, b.col);
    else {
      rows[0] = sliceColumns(rows[0], a.col);
      rows[rows.length - 1] = sliceColumns(rows[rows.length - 1], 0, b.col);
    }
    return { rows, firstPrefix, firstInset: a.col };
  }

  // 크롭된 DOM 폭으로 셀을 다시 추정하지 않고, 첫 휠 직전 xterm이 확정한 선택 양끝 중
  // 현재 포인터에서 먼 쪽을 원래 mousedown 앵커로 채택한다. xterm의 end는 exclusive라
  // 역방향 선택에서도 그대로 써야 마지막 셀이 빠지지 않는다.
  function nativeSelectionAnchor(selection, focusPosition, viewportRows, terminalCols, skip = 0) {
    const rows = Math.max(0, Math.floor(Number(viewportRows) || 0));
    const cols = Math.max(0, Math.floor(Number(terminalCols) || 0));
    const inset = Math.max(0, Math.min(cols, Math.floor(Number(skip) || 0)));
    const focusRow = Math.floor(Number(focusPosition && focusPosition.row));
    const focusCol = Math.floor(Number(focusPosition && focusPosition.col));
    if (!rows || !cols || !Number.isInteger(focusRow) || !Number.isInteger(focusCol)) return null;
    const point = (value) => {
      let x = Math.floor(Number(value && value.x)), y = Math.floor(Number(value && value.y));
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > cols || y < 0) return null;
      // 마지막 셀을 포함한 exclusive end는 다음 행 0열로 표현될 수 있다.
      if (y === rows && x === 0) { y = rows - 1; x = cols; }
      if (y >= rows) return null;
      return { x, y, offset: y * cols + x };
    };
    const start = point(selection && selection.start), end = point(selection && selection.end);
    if (!start || !end || start.offset === end.offset) return null;
    const focus = Math.max(0, Math.min(rows * cols, focusRow * cols + focusCol));
    const anchor = Math.abs(start.offset - focus) <= Math.abs(end.offset - focus) ? end : start;
    return { row: anchor.y, col: Math.max(0, Math.min(cols - inset, anchor.x - inset)) };
  }

  // 대체 화면에는 스크롤되는 본문과 같은 자리에 남는 header/status/prompt가 함께 있다.
  // 두 프레임에서 비어 있지 않은 행이 같은 방향으로 이동한 증거만 모아 본문 밴드를 찾는다.
  function scrollableRegion(previousRows, nextRows, expected = 0) {
    if (!Array.isArray(previousRows) || !Array.isArray(nextRows)) return null;
    const count = Math.min(previousRows.length, nextRows.length);
    const direction = Math.sign(Number(expected) || 0);
    if (!direction || count < 4) return null;
    const want = Math.max(1, Math.min(count - 1, Math.abs(Math.round(Number(expected) || 0))));
    // 한 프레임 안에 똑같이 생긴 행이 여럿이면(구분선 ───, 반복되는 여백 표시 등) 그 행이 어디서
    // 어디로 옮겨졌는지 확정할 수 없다. 서로 다른 위치끼리 맞아떨어져 밴드가 크롬 쪽으로
    // 늘어난다. 확인 결과: 구분선 두 줄 간격(2행)만큼 스크롤하면 밴드가 51→55로 늘고
    // ❯ 입력줄까지 본문에 들어왔다. 프레임 안에서 유일한 행만 이동의 근거로 쓴다.
    const tally = (rows) => {
      const m = new Map();
      for (let i = 0; i < count; i++) {
        const k = String(rows[i] == null ? "" : rows[i]);
        m.set(k, (m.get(k) || 0) + 1);
      }
      return m;
    };
    const prevSeen = tally(previousRows), nextSeen = tally(nextRows);
    let best = null;
    for (let amount = 1; amount < count; amount++) {
      const shift = direction * amount, matches = [];
      for (let i = 0; i < count; i++) {
        const oldIndex = i + shift;
        if (oldIndex < 0 || oldIndex >= count) continue;
        const oldRow = String(previousRows[oldIndex] == null ? "" : previousRows[oldIndex]);
        const newRow = String(nextRows[i] == null ? "" : nextRows[i]);
        if (oldRow.trim() && oldRow === newRow
          && prevSeen.get(oldRow) === 1 && nextSeen.get(newRow) === 1) matches.push(i);
      }
      const distance = Math.abs(amount - want);
      if (!best || matches.length > best.matches.length
        || (matches.length === best.matches.length && distance < best.distance))
        best = { shift, matches, distance };
    }
    if (!best || best.matches.length < 3) return null;
    const first = best.matches[0], last = best.matches[best.matches.length - 1];
    const start = Math.max(0, first + Math.min(best.shift, 0));
    let end = Math.min(count, last + Math.max(best.shift, 0) + 1);
    // 유일한 행 일치만으로는 본문 맨 아래가 빠진다. 스크롤 중에는 맨 아래 본문 행 오른쪽에
    // 바닥으로 가기 힌트가 겹쳐 그려지고, 빈 줄은 근거가 못 된다. 확인 결과: 밴드가 입력창
    // 위 본문 끝보다 한두 줄 위에서 끝나 선택이 거기서 멈췄다. 옮겨진 짝이 빈 줄끼리이거나
    // 같은 행이거나 앞부분이 같은 행이면 밴드에 붙이되, 빈 줄은 뒤에 근거 있는 행이 올 때만 붙인다.
    const baseEnd = end;
    for (let row = end; row < count; row++) {
      const i = row - Math.max(best.shift, 0), oldIndex = i + best.shift;
      if (i < 0 || i >= count || oldIndex < 0 || oldIndex >= count) break;
      const a = String(previousRows[oldIndex] == null ? "" : previousRows[oldIndex]);
      const b = String(nextRows[i] == null ? "" : nextRows[i]);
      if (!a.trim() && !b.trim()) continue;
      if (a === b || sameHead(a, b)) end = row + 1;
      else break;
    }
    return end - start >= 3 ? { start, end, shift: best.shift, soft: end - baseEnd } : null;
  }

  // 한 행 위에 다른 글자가 겹쳐 그려졌어도 같은 행인지. 겹친 쪽은 오른쪽 끝이라 앞부분이 남는다.
  // 앞부분이 짧으면 비슷하게 시작하는 다른 행(번호 붙은 줄 등)과 구분되지 않으므로, 공백이 아닌
  // 글자가 8개 이상 같거나 짧은 쪽 행 전체가 같을 때만 인정한다.
  function sameHead(a, b) {
    const x = Array.from(a), y = Array.from(b);
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    const head = x.slice(0, n).join("");
    const shorter = (x.length <= y.length ? a : b).trimEnd();
    const visible = head.replace(/\s/gu, "").length;
    return visible >= 8 || (visible >= 3 && head.trimEnd() === shorter);
  }

  // 새 화면을 누적 행 좌표에 놓는다. 최초 화면은 드래그 시작 당시의 원문이므로 이후 화면이
  // 같은 자리를 다시 그려도 덮지 않는다. 시작점의 텍스트 정체성이 좌표보다 우선이다.
  function alignRows(state, rows, expected = 0) {
    if (!state || !Array.isArray(state.virtual) || !Array.isArray(rows))
      throw new Error("virtual scroll state unavailable");
    const nextRows = rows.map((row) => String(row == null ? "" : row));
    const count = nextRows.length;
    if (!count) return state.view || 0;
    if (!state.virtual.length) {
      state.virtual = nextRows.slice();
      state.view = 0;
      state.lockStart = 0;
      state.lockEnd = count - 1;
      return state.view;
    }

    // 밴드 끝에 붙인 행은 스크롤 중 힌트가 겹쳐 있을 수 있다. 이미 받은 행을 그것으로 덮지 않는다.
    const soft = Math.max(0, Math.min(count, Number(state.viewportSoft) || 0));
    const want = (Number.isInteger(state.view) ? state.view : 0) + (Number(expected) || 0);
    let best = null, bestHits = -1, bestCompared = 0, bestDistance = Infinity;
    for (let position = state.view - count; position <= state.view + count; position++) {
      let compared = 0, hits = 0;
      for (let i = 0; i < count; i++) {
        const old = state.virtual[position + i];
        if (old === undefined) continue;
        compared++;
        if (old === nextRows[i]) hits++;
      }
      // 겹친 행이 몇 줄뿐인 위치는 우연히 맞아도 비율이 높게 나온다. 확인 결과: 6줄만 겹친 위치를
      // 5/6 일치로 골라 41줄을 건너뛰었다. 화면의 3분의 1 이상 겹치는 위치만 후보로 본다.
      if (compared < Math.min(count, Math.max(4, Math.ceil(count / 3)))) continue;
      const distance = Math.abs(position - want);
      if (hits > bestHits || (hits === bestHits && distance < bestDistance)) {
        best = position; bestHits = hits; bestCompared = compared; bestDistance = distance;
      }
    }
    // 겹치는 행이 6할도 안 맞으면 어느 위치에 놓아야 할지 확정할 수 없다. 그래도 예상 위치에
    // 놓아야 화면 표시가 끊기지 않지만, 그렇게 놓은 결과는 추정값이다. 클립보드로 나갈 때는
    // 추정인지 아닌지를 구분해야 한다.
    //
    // 한 프레임이 저신뢰였다는 사실을 드래그 전체에 적용하면 안 된다. 오래 끄는 동안 스피너·
    // 토큰 수처럼 매 프레임 바뀌는 줄 때문에 한 번은 저신뢰가 되는데, 그것으로 137행짜리
    // 정상 복사가 통째로 막힌다. 저신뢰인 것은 그때 놓은 구간뿐이므로 구간으로 기록하고,
    // 고른 범위가 그 구간에 걸릴 때만 막는다.
    const guessed = best === null || bestHits < bestCompared * 0.6;
    // 임시 진단: 어느 프레임이 어디로 놓았는지. 원인이 잡히면 지운다.
    if (Array.isArray(state.trace)) state.trace.push({
      view: state.view, want, chose: guessed ? want : best,
      hits: bestHits, compared: bestCompared, count, guessed,
      head: String(nextRows[0] || "").slice(0, 24),
    });
    if (guessed) best = want;

    if (best < 0) {
      const prepend = -best;
      state.virtual = nextRows.slice(0, prepend).concat(state.virtual);
      state.anchorIdx += prepend;
      state.lockStart += prepend;
      state.lockEnd += prepend;
      if (Array.isArray(state.uncertainRanges))
        for (const r of state.uncertainRanges) { r[0] += prepend; r[1] += prepend; }
      best = 0;
    }
    markRows(state, best, best + count - 1, guessed);
    for (let i = 0; i < count; i++) {
      const index = best + i;
      while (state.virtual.length < index) state.virtual.push(undefined);
      if (index >= state.virtual.length) state.virtual.push(nextRows[i]);
      else if (i >= count - soft && state.virtual[index] !== undefined) continue;
      else if (index < state.lockStart || index > state.lockEnd) state.virtual[index] = nextRows[i];
    }
    state.view = best;
    return state.view;
  }

  // 최초 원문은 그대로 잠그되, 첫 실제 스크롤 프레임에서 움직인 본문 밴드를 알아낸 뒤
  // 고정 TUI 행을 가상 문서에서 제외한다. 판별 전 프레임은 기존 전체 화면 정렬로 안전하게 폴백한다.
  function alignViewport(state, rows, expected = 0) {
    if (!state || !Array.isArray(rows)) throw new Error("viewport scroll state unavailable");
    const nextRows = rows.map((row) => String(row == null ? "" : row));
    if (!Array.isArray(state.initialRows)) {
      state.initialRows = nextRows.slice();
      state.initialAnchorRow = Number.isInteger(state.initialAnchorRow)
        ? state.initialAnchorRow : Number(state.anchorIdx) || 0;
      state.expectedOffset = 0;
      state.viewportTop = 0;
      state.viewportRows = nextRows.length;
      return alignRows(state, nextRows, expected);
    }

    state.expectedOffset = (Number(state.expectedOffset) || 0) + (Number(expected) || 0);
    if (!state.viewportResolved && state.expectedOffset) {
      const region = scrollableRegion(state.initialRows, nextRows, state.expectedOffset);
      const anchorRow = Number(state.initialAnchorRow);
      if (region) {
        // 최신 출력이 화면 아래에 붙어 있어 드래그는 고정 크롬(입력줄·구분선·상태줄)에서
        // 시작하는 경우가 많다. 앵커가 밴드 밖이라고 판별을 버리면 크롬이 든 화면 전체가
        // 본문으로 쌓여 클립보드에 구분선과 입력줄이 섞여 나간다.
        // 끝점은 이미 밴드 경계로 맞춘다(edgeNormalizeFocus). 앵커도 같게 다룬다.
        const last = region.end - 1;
        const raw = Number.isInteger(anchorRow) ? anchorRow : region.start;
        const clamped = Math.max(region.start, Math.min(last, raw));
        // 밴드 아래에서 시작했으면 밴드 마지막 행 끝부터, 위에서 시작했으면 첫 행 처음부터가
        // 그 드래그가 실제로 덮은 범위다.
        if (raw > last) state.anchorCol = colWidth(state.initialRows[last]);
        else if (raw < region.start) state.anchorCol = 0;
        state.virtual = state.initialRows.slice(region.start, region.end);
        state.view = 0;
        state.anchorIdx = clamped - region.start;
        state.lockStart = 0;
        state.lockEnd = state.virtual.length - 1;
        state.viewportTop = region.start;
        state.viewportRows = region.end - region.start;
        state.viewportSoft = region.soft;
        state.viewportResolved = true;
        state.lastRows = nextRows.slice();
        return alignRows(state, nextRows.slice(region.start, region.end), region.shift);
      }
    }

    // 밴드를 첫 스크롤에 한 번 정하고 드래그 내내 고정으로 쓰면, 화면 구성이 도중에 바뀔 때
    // (작업중 표시가 생겼다 사라지고, 아래로 가기 힌트가 붙었다 떨어진다) 잘라내는 범위가 달라진다.
    // 그러면 크롬이 본문에 섞이거나 본문 한 줄이 범위 밖으로 밀려 정렬이 흔들린다. 확인 결과:
    // 같은 화면에서 회차마다 밴드가 46·47·51·52로 달랐다. 그래서 프레임마다 직전 프레임과
    // 대조해 다시 잡되, 값이 튀는 것이 더 나쁘므로 크기·시작이 크게 어긋나는 판정은 버리고
    // 쓰던 밴드를 유지한다.
    if (state.viewportResolved && Array.isArray(state.lastRows)) {
      const again = scrollableRegion(state.lastRows, nextRows, expected);
      if (again) {
        const size = again.end - again.start;
        if (Math.abs(again.start - state.viewportTop) <= 3
          && Math.abs(size - state.viewportRows) <= 3 && size >= 3) {
          state.viewportTop = again.start;
          state.viewportRows = size;
          state.viewportSoft = again.soft;
        }
      }
    }
    state.lastRows = nextRows.slice();
    const top = state.viewportResolved ? state.viewportTop : 0;
    const count = state.viewportResolved ? state.viewportRows : nextRows.length;
    return alignRows(state, nextRows.slice(top, top + count), expected);
  }

  // 현재 어느 행이 추정값인지를 구간 목록으로 유지한다. 프레임마다 갱신되므로, 추정으로 놓은
  // 행을 다음 프레임이 고신뢰로 덮으면 그 행은 더 이상 추정이 아니다. 한 번 저신뢰였다는
  // 기록을 남겨 두면 오래 끄는 동안 전체 복사가 막힌다.
  function rangeAdd(list, from, to) {
    if (to < from) return list;
    list.push([from, to]);
    list.sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of list) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    return out;
  }
  function rangeSub(list, from, to) {
    if (to < from) return list;
    const out = [];
    for (const [a, b] of list) {
      if (b < from || a > to) { out.push([a, b]); continue; }
      if (a < from) out.push([a, from - 1]);
      if (b > to) out.push([to + 1, b]);
    }
    return out;
  }
  // 잠긴 구간(최초 화면 원문)은 추정 프레임을 포함해 어떤 프레임도 덮지 않는다.
  // 그래서 그 안쪽에는 저신뢰 표시도 해제도 적용하지 않는다.
  function markRows(state, from, to, guessed) {
    const lockLo = Number(state.lockStart), lockHi = Number(state.lockEnd);
    const parts = (Number.isInteger(lockLo) && Number.isInteger(lockHi) && lockHi >= lockLo)
      ? [[from, Math.min(to, lockLo - 1)], [Math.max(from, lockHi + 1), to]]
      : [[from, to]];
    let list = Array.isArray(state.uncertainRanges) ? state.uncertainRanges : [];
    for (const [a, b] of parts) {
      if (b < a) continue;
      list = guessed ? rangeAdd(list, a, b) : rangeSub(list, a, b);
    }
    state.uncertainRanges = list;
    state.uncertain = list.length > 0;
  }

  // 로컬 누적물로 복사해도 되는가. 안 되는 이유를 돌려주고, 괜찮으면 빈 문자열이다.
  //
  // 이 검사가 없으면 손상이 "짧게 잘림"이 아니라 "내용이 다름"으로 나간다. 한 번에 여러 행을
  // 건너뛰도록 스크롤하면 그 사이 행은 그려지지 않아 빈 구간으로 남는데, pickRows가 그것을
  // 빈 문자열로 바꾸므로 최종 텍스트에서 터미널에 실제로 있던 빈 줄과 구별되지 않는다.
  // 확인 결과: 6행 건너뛰면 복사본에 빈 줄이 6개 생긴다. 저신뢰 정렬도 다른 행을 같은
  // 위치에 넣는다. 둘 다 "잘렸을 수 있다"고 알리는 것만으로는 막지 못한다. 받는 사람은
  // 잘린 것으로 알지만 실제로는 내용이 바뀌어 있다.
  function localCopyDefect(state, endPosition) {
    if (!state || !Array.isArray(state.virtual) || !state.virtual.length) return "no captured rows";
    if (!state.viewportResolved) return "band unresolved";
    const a = Number(state.anchorIdx), b = Number(state.view) + Number(endPosition && endPosition.row);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return "range invalid";
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (lo < 0 || hi >= state.virtual.length) return "range outside captured rows";
    for (let i = lo; i <= hi; i++) if (state.virtual[i] == null) return "gap in captured rows";
    return "";
  }

  // 막지는 않고 알리기만 하는 것. 빈 구간과 달리 정렬 어긋남은 결과에 그대로 보인다.
  // 문단이 끊기거나 다른 대목이 이어 붙으므로 받는 사람이 알아볼 수 있고, 그런 손상은
  // 막는 것보다 알리는 편이 낫다. 확인 결과: 이 신호는 정상 본문(47~70행)에도 걸렸고,
  // 그것으로 복사를 막으면 사용자가 아무것도 가져가지 못한다.
  function localCopyDoubt(state, endPosition) {
    if (!state || !Array.isArray(state.virtual)) return 0;
    const a = Number(state.anchorIdx), b = Number(state.view) + Number(endPosition && endPosition.row);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return 0;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    let rows = 0;
    for (const r of (state.uncertainRanges || [])) {
      const from = Math.max(r[0], lo), to = Math.min(r[1], hi);
      if (to >= from) rows += to - from + 1;
    }
    return rows;
  }

  function pickRows(state, endPosition) {
    if (!state || !Array.isArray(state.virtual) || !state.virtual.length)
      throw new Error("virtual scroll state unavailable");
    const endRow = Number(endPosition && endPosition.row);
    const endCol = Math.max(0, Math.floor(Number(endPosition && endPosition.col) || 0));
    if (!Number.isInteger(endRow) || endRow < 0) throw new Error("screen row invalid");

    let a = Number(state.anchorIdx), b = Number(state.view) + endRow;
    let aCol = Math.max(0, Math.floor(Number(state.anchorCol) || 0)), bCol = endCol;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0
      || a >= state.virtual.length || b >= state.virtual.length) throw new Error("virtual range unavailable");
    if (b < a || (b === a && bCol < aCol)) { [a, b] = [b, a]; [aCol, bCol] = [bCol, aCol]; }

    const rows = state.virtual.slice(a, b + 1).map((row) => String(row == null ? "" : row));
    const firstPrefix = sliceColumns(rows[0], 0, aCol);
    if (rows.length === 1) rows[0] = sliceColumns(rows[0], aCol, bCol);
    else {
      rows[0] = sliceColumns(rows[0], aCol);
      rows[rows.length - 1] = sliceColumns(rows[rows.length - 1], 0, bCol);
    }
    return { rows, firstPrefix, firstInset: aCol };
  }

  // 가상 선택 범위 중 지금 보이는 부분을 xterm의 단일 선형 선택 좌표로 바꾼다.
  // 화면 밖에 있는 시작/끝은 content의 왼쪽/오른쪽 경계로 잘라 기본 선택색만 다시 그릴 수 있게 한다.
  function visibleSelection(state, endPosition, viewportRows, terminalCols, skip = 0) {
    const rows = Math.max(0, Math.floor(Number(viewportRows) || 0));
    const cols = Math.max(0, Math.floor(Number(terminalCols) || 0));
    const inset = Math.max(0, Math.min(cols, Math.floor(Number(skip) || 0)));
    const view = Number(state && state.view), anchor = Number(state && state.anchorIdx);
    const endRow = Number(endPosition && endPosition.row);
    if (!rows || !cols || !Number.isInteger(view) || !Number.isInteger(anchor)
      || !Number.isInteger(endRow) || endRow < 0 || endRow >= rows) return null;

    const contentCols = cols - inset;
    let a = anchor, b = view + endRow;
    let aCol = Math.max(0, Math.min(contentCols, Math.floor(Number(state.anchorCol) || 0)));
    let bCol = Math.max(0, Math.min(contentCols, Math.floor(Number(endPosition.col) || 0)));
    if (b < a || (b === a && bCol < aCol)) { [a, b] = [b, a]; [aCol, bCol] = [bCol, aCol]; }

    const first = Math.max(a, view), last = Math.min(b, view + rows - 1);
    if (first > last) return null;
    const firstCol = first === a ? aCol : 0;
    const lastCol = last === b ? bCol : contentCols;
    const top = Math.max(0, Math.floor(Number(state && state.viewportTop) || 0));
    const col = inset + firstCol, row = top + first - view;
    const length = (last - first) * cols + (inset + lastCol) - col;
    return length > 0 ? { col, row, length } : null;
  }

  root.IrisScrollbackCopy = Object.freeze({
    alignRows, alignViewport, localCopyDefect, localCopyDoubt, nativeSelectionAnchor, parseRows,
    pickHistoryRows, pickRows, scrollableRegion, sliceColumns, terminalContentRow,
    visibleSelection,
  });
})(globalThis);
