// 선택한 창의 저장 모형과 재결합·순환 규칙을 소유한다.
//
// 소유 범위
//   창 순번, 현재 창과 저장 항목의 일대일 재결합, 선택 순환의 시작점. serialize은 항목 수
//   제한 안에서 선택을 버리지 않고 저장 가능한 기본값으로 메우며, deserialize는 저장 입력을
//   엄격하게 검증한다.
//
// 제공 API
//   assignOrdinals · matchWindow · reconcile · pruneDeadProcesses · pick · unpick · movePicked · selectTarget ·
//   groupPicked · leavePicked · ungroup · findOwnWindow · planStops · stopIdOf · serialize · deserialize 를 순수 함수로 제공한다.
//
// 의존 대상
//   호출자가 넘긴 창 목록, 선택 상태, 살아 있는 프로세스 표만 본다. 파일·프로세스·Electron과
//   실행 환경의 전역 기능에는 기대지 않는다.
//
// 유지 조건
//   같은 제목의 창 순번은 z-order가 아니라 bounds로 정한다. 세션에서는 사라진 선택을 남기고
//   재시작에서는 버린다. 세션에서는 같은 앱의 같은 CGWindowID라면 제목이 바뀌어도 같은 창이지만,
//   재시작 재결합은 안정 앱 열쇠(구 저장본은 앱 이름)+제목+순번만 쓰고, 찾지 못하면 제외한다.
//   저장할 때 불완전한 선택은 기본값으로 보존하고, 불러올 때 pid 0은 host가 생존 여부를 판정하도록 남긴다.
//   모든 반환값은 새 값이며 호출자가 준 객체와 배열을 고치지 않는다.
//   묶음: 선택 목록에서 붙어 있고 group 값이 같은 항목들. 단축키 한 번에 묶음 하나를 올림
//   group 없는 항목: 혼자 한 차례
//   떨어진 같은 group 값과 하나만 남은 묶음: normalizeGroups 가 정리
//
// 영향 범위
//   공급자는 창 목록과 프로세스 생존표를 만드는 host다. 소비자는 설정의 선택 목록과 화면을
//   띄우지 않는 창 전환 host이며, 저장 형식 version 1도 이 계약을 함께 쓴다.
//   현재 목록 확인: node bin/importers.mjs native/electron/switcher-core.cjs

var PICK_KEY_SEP = "\u001f";

function effectiveAppKey(item) {
  var value = item && typeof item.appKey === "string" ? item.appKey : "";
  return value && value.indexOf("pid:") !== 0 ? value : "";
}

function sameApplication(left, right) {
  var leftKey = effectiveAppKey(left);
  var rightKey = effectiveAppKey(right);
  if (leftKey && rightKey) return leftKey === rightKey;
  return !!(left && right && left.matchApp === right.matchApp);
}

function isInteger(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function copyValue(value) {
  return Array.isArray(value) ? value.slice() : value;
}

function copyObject(source) {
  var target = {};
  var key;
  if (!source || typeof source !== "object") return target;
  for (key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = copyValue(source[key]);
  }
  return target;
}

function copyState(state) {
  var picked = [];
  var source = state && Array.isArray(state.picked) ? state.picked : [];
  var i;
  for (i = 0; i < source.length; i += 1) picked.push(copyObject(source[i]));
  return {
    version: 1,
    picked: picked,
    cursor: state && isInteger(state.cursor) ? state.cursor : null,
  };
}

function emptyState() {
  return { version: 1, picked: [], cursor: null };
}

var GROUP_LIMIT = 40;

function groupOf(item) {
  return item && typeof item.group === "string" && item.group ? item.group : "";
}

// 붙어 있는 같은 group 항목의 [start, end) 범위 목록. group 없는 항목은 혼자 한 범위
function stopRanges(picked) {
  var ranges = [];
  var i = 0;
  var end;
  var group;
  while (i < picked.length) {
    group = groupOf(picked[i]);
    end = i + 1;
    if (group) {
      while (end < picked.length && groupOf(picked[end]) === group) end += 1;
    }
    ranges.push({ start: i, end: end });
    i = end;
  }
  return ranges;
}

function rangeOfIndex(ranges, index) {
  var i;
  for (i = 0; i < ranges.length; i += 1) {
    if (index >= ranges[i].start && index < ranges[i].end) return i;
  }
  return -1;
}

function freshGroupName(used) {
  var n = 1;
  while (used["g" + n]) n += 1;
  used["g" + n] = true;
  return "g" + n;
}

// 하나만 남은 묶음의 group 삭제, 떨어진 같은 group 의 뒤쪽에 새 이름 부여
// 이 모듈이 만든 사본 picked 를 그 자리에서 수정
function normalizeGroups(picked) {
  var ranges = stopRanges(picked);
  var used = {};
  var all = {};
  var i;
  var j;
  var group;
  var name;
  for (i = 0; i < picked.length; i += 1) {
    if (groupOf(picked[i])) all[groupOf(picked[i])] = true;
  }
  for (i = 0; i < ranges.length; i += 1) {
    group = groupOf(picked[ranges[i].start]);
    if (!group) continue;
    if (ranges[i].end - ranges[i].start < 2) {
      delete picked[ranges[i].start].group;
      continue;
    }
    name = group;
    if (used[group]) name = freshGroupName(all);
    used[name] = true;
    for (j = ranges[i].start; j < ranges[i].end; j += 1) picked[j].group = name;
  }
  return picked;
}

function itemMatchesRef(item, id, pickKey) {
  if (isInteger(id)) return itemOwnsId(item, id);
  if (typeof pickKey !== "string") return false;
  return item.pickKey === pickKey || (typeof item.pickKey !== "string" && pickKeyFor(item) === pickKey);
}

function indexOfRef(picked, options) {
  var id = options ? options.id : null;
  var pickKey = options ? options.pickKey : null;
  var i;
  for (i = 0; i < picked.length; i += 1) {
    if (itemMatchesRef(picked[i], id, pickKey)) return i;
  }
  return -1;
}

function pickKeyFor(item) {
  var appIdentity = effectiveAppKey(item) || (item && typeof item.matchApp === "string" ? item.matchApp : "");
  var matchTitle = item && typeof item.matchTitle === "string" ? item.matchTitle : "";
  var ordinal = item && isInteger(item.ordinal) && item.ordinal >= 1 ? item.ordinal : 1;
  return appIdentity + PICK_KEY_SEP + matchTitle + PICK_KEY_SEP + String(ordinal);
}

function validBounds(bounds) {
  var i;
  if (!Array.isArray(bounds) || bounds.length !== 4) return false;
  for (i = 0; i < bounds.length; i += 1) {
    if (!isInteger(bounds[i])) return false;
  }
  return true;
}

function sameBounds(left, right) {
  var i;
  if (!validBounds(left) || !validBounds(right)) return false;
  for (i = 0; i < 4; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function compareBounds(left, right) {
  var a = validBounds(left.bounds) ? left.bounds : [0, 0, 0, 0];
  var b = validBounds(right.bounds) ? right.bounds : [0, 0, 0, 0];
  var i;
  for (i = 0; i < 4; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }

  // bounds가 완전히 같을 때도 입력 순서를 쓰지 않도록 세션 지역 식별자로만 동률을 가른다.
  if (isInteger(left.id) && isInteger(right.id) && left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (isInteger(left.cgId) && isInteger(right.cgId) && left.cgId !== right.cgId) return left.cgId < right.cgId ? -1 : 1;
  return 0;
}

function assignOrdinals(windows) {
  var source = Array.isArray(windows) ? windows : [];
  var result = [];
  var groups = [];
  var i;
  var j;
  var group;
  var item;

  for (i = 0; i < source.length; i += 1) result.push(copyObject(source[i]));
  for (i = 0; i < result.length; i += 1) {
    group = null;
    for (j = 0; j < groups.length; j += 1) {
      if (sameApplication(groups[j].representative, result[i]) && groups[j].matchTitle === result[i].matchTitle) {
        group = groups[j];
        break;
      }
    }
    if (!group) {
      group = { representative: result[i], matchTitle: result[i].matchTitle, items: [] };
      groups.push(group);
    }
    group.items.push(result[i]);
  }

  for (i = 0; i < groups.length; i += 1) {
    groups[i].items.sort(compareBounds);
    for (j = 0; j < groups[i].items.length; j += 1) {
      item = groups[i].items[j];
      item.ordinal = j + 1;
    }
  }
  return result;
}

function sameProcess(left, right) {
  return left.pid === right.pid && left.pidStart === right.pidStart;
}

function matchWindow(saved, candidate, phase) {
  var appMatches = sameApplication(saved, candidate);
  var restartMatch = typeof saved.matchTitle === "string" && isInteger(saved.ordinal) && appMatches &&
    candidate.matchTitle === saved.matchTitle && candidate.ordinal === saved.ordinal;
  if (phase === "restart") return restartMatch ? 1 : 0;
  if (!appMatches) return 0;
  if (saved.cgId !== null && saved.cgId !== undefined &&
      candidate.cgId !== null && candidate.cgId !== undefined &&
      candidate.cgId === saved.cgId) return 1;
  if (sameProcess(saved, candidate) && candidate.matchTitle === saved.matchTitle) return 2;
  if (sameProcess(saved, candidate) && sameBounds(candidate.bounds, saved.bounds)) return 3;
  return restartMatch ? 4 : 0;
}

// 재시작 재결합에서 선택한 창을 제외하는 경우는 하나뿐이다. 그 앱의 창 목록을 실제로 읽었는데
// 그 안에 없을 때다. 열거가 실패했거나(권한을 다시 요청하면 그렇게 된다) 제목을 읽지 못하면
// 관측 자체가 없는 것이므로 제외하지 않는다. 그때 제외하면 사용자가 고른 창이 사라진다
// (권한이 끊겨 열거가 실패한 상태에서 선택이 전부 지워진 적이 있다).
function appWasSeen(saved, windows) {
  var i;
  for (i = 0; i < windows.length; i += 1) {
    if (!sameApplication(saved, windows[i])) continue;
    if (typeof windows[i].matchTitle === "string" && windows[i].matchTitle !== "") return true;
  }
  return false;
}

function findMatch(saved, windows, used, phase) {
  var i;
  var best = -1;
  var bestPriority = 0;
  var priority;

  for (i = 0; i < windows.length; i += 1) {
    if (used[i]) continue;
    priority = matchWindow(saved, windows[i], phase);
    if (priority > 0 && (bestPriority === 0 || priority < bestPriority)) {
      best = i;
      bestPriority = priority;
    }
  }
  return best;
}

function itemOwnsId(item, id) {
  if (!isInteger(id)) return false;
  return item.id === id || item.cgId === id;
}

function reconcile(options) {
  var state = copyState(options && options.state);
  var windows = assignOrdinals(options && options.windows);
  var phase = options && options.phase === "restart" ? "restart" : "session";
  var used = [];
  var nextPicked = [];
  var hidden = [];
  var dropped = 0;
  var cursor = state.cursor;
  var i;
  var match;
  var saved;
  var current;
  var updated;
  var row;
  var rows = [];

  for (i = 0; i < windows.length; i += 1) used.push(false);
  for (i = 0; i < state.picked.length; i += 1) {
    saved = state.picked[i];
    if (typeof saved.pickKey !== "string") saved.pickKey = pickKeyFor(saved);
    if (saved.dead === true || saved.processAlive === false) {
      if (itemOwnsId(saved, cursor)) cursor = null;
      dropped += 1;
      continue;
    }

    match = findMatch(saved, windows, used, phase);
    if (match >= 0) {
      current = windows[match];
      used[match] = true;
      updated = copyObject(saved);
      updated.id = current.id;
      updated.cgId = current.cgId;
      updated.pid = current.pid;
      updated.pidStart = current.pidStart;
      updated.bounds = validBounds(current.bounds) ? current.bounds.slice() : current.bounds;
      updated.matchApp = current.matchApp;
      updated.matchTitle = current.matchTitle;
      updated.ordinal = isInteger(current.ordinal) && current.ordinal >= 1 ? current.ordinal : 1;
      if (typeof current.appKey === "string" && current.appKey) updated.appKey = current.appKey;
      else delete updated.appKey;
      updated.pickKey = pickKeyFor(updated);
      if (typeof current.displayApp === "string") updated.displayApp = current.displayApp;
      if (typeof current.displayTitle === "string") updated.displayTitle = current.displayTitle;
      if (itemOwnsId(saved, cursor)) cursor = current.id;
      nextPicked.push(updated);
      continue;
    }

    if (phase === "restart" && appWasSeen(saved, windows)) {
      if (itemOwnsId(saved, cursor)) cursor = null;
      dropped += 1;
    } else {
      nextPicked.push(copyObject(saved));
      hidden.push(saved);
    }
  }

  for (i = 0; i < windows.length; i += 1) {
    row = copyObject(windows[i]);
    row.pickKey = pickKeyFor(row);
    row.picked = used[i] === true;
    rows.push(row);
  }
  for (i = 0; i < hidden.length; i += 1) {
    row = {
      id: null,
      pickKey: hidden[i].pickKey,
      displayApp: typeof hidden[i].displayApp === "string" ? hidden[i].displayApp : hidden[i].matchApp,
      displayTitle: typeof hidden[i].displayTitle === "string" ? hidden[i].displayTitle : hidden[i].matchTitle,
      picked: true,
      visible: false,
    };
    if (typeof hidden[i].appKey === "string" && hidden[i].appKey) row.appKey = hidden[i].appKey;
    rows.push(row);
  }

  return { state: { version: 1, picked: normalizeGroups(nextPicked), cursor: cursor }, rows: rows, dropped: dropped };
}

function pruneDeadProcesses(options) {
  var state = copyState(options && options.state);
  var alive = options && options.alive && typeof options.alive === "object" ? options.alive : {};
  var picked = [];
  var cursor = state.cursor;
  var removed = 0;
  var i;
  var item;
  var key;

  for (i = 0; i < state.picked.length; i += 1) {
    item = state.picked[i];
    key = String(item.pid) + "|" + String(item.pidStart);
    if (alive[key] === true) {
      picked.push(copyObject(item));
    } else {
      if (itemOwnsId(item, cursor)) cursor = null;
      removed += 1;
    }
  }
  return { state: { version: 1, picked: normalizeGroups(picked), cursor: cursor }, removed: removed };
}

function samePickedWindow(item, window) {
  if (!sameApplication(item, window)) return false;
  if (item.cgId !== null && item.cgId !== undefined && window.cgId !== null && window.cgId !== undefined) {
    return item.cgId === window.cgId;
  }
  if (isInteger(item.id) && isInteger(window.id)) return item.id === window.id;
  if (sameProcess(item, window) && item.matchTitle === window.matchTitle) return true;
  if (sameProcess(item, window) && sameBounds(item.bounds, window.bounds)) return true;
  return item.matchTitle === window.matchTitle &&
    item.ordinal === (isInteger(window.ordinal) && window.ordinal >= 1 ? window.ordinal : 1);
}

function pick(options) {
  var state = copyState(options && options.state);
  var window = options && options.window ? options.window : {};
  var i;
  var item;

  for (i = 0; i < state.picked.length; i += 1) {
    if (samePickedWindow(state.picked[i], window)) return state;
  }

  item = {
    id: window.id,
    cgId: isInteger(window.cgId) ? window.cgId : null,
    pid: window.pid,
    pidStart: window.pidStart,
    matchApp: window.matchApp,
    matchTitle: window.matchTitle,
    ordinal: isInteger(window.ordinal) && window.ordinal >= 1 ? window.ordinal : 1,
    bounds: validBounds(window.bounds) ? window.bounds.slice() : window.bounds,
  };
  if (typeof window.appKey === "string" && window.appKey) item.appKey = window.appKey;
  item.pickKey = pickKeyFor(item);
  if (typeof window.displayApp === "string") item.displayApp = window.displayApp;
  if (typeof window.displayTitle === "string") item.displayTitle = window.displayTitle;
  state.picked.push(item);
  return state;
}

function unpick(options) {
  var state = copyState(options && options.state);
  var id = options ? options.id : null;
  var pickKey = options ? options.pickKey : null;
  var hasId = isInteger(id);
  var hasPickKey = typeof pickKey === "string";
  var picked = [];
  var removedCursor = false;
  var i;
  var matches;

  if (!hasId && !hasPickKey) return state;

  for (i = 0; i < state.picked.length; i += 1) {
    matches = hasId ? itemOwnsId(state.picked[i], id) :
      (state.picked[i].pickKey === pickKey ||
        (typeof state.picked[i].pickKey !== "string" && pickKeyFor(state.picked[i]) === pickKey));
    if (matches) {
      if (itemOwnsId(state.picked[i], state.cursor)) removedCursor = true;
    } else {
      picked.push(copyObject(state.picked[i]));
    }
  }
  return { version: 1, picked: normalizeGroups(picked), cursor: removedCursor ? null : state.cursor };
}

// 혼자인 창과 unit "stop": 차례 전체를 이웃 차례 너머로 이동
// 묶음 안의 창: 그 묶음 안에서만 이동. 맨 앞 창이 전환 때 포커스를 받아 묶음 안 순서도 의미 있음
function movePicked(options) {
  var original = options && options.state;
  var picked = original && Array.isArray(original.picked) ? original.picked : null;
  var direction = options ? options.dir : null;
  var index;
  var ranges;
  var at;
  var range;
  var neighbor;
  var state;
  var item;
  var block;
  var target;

  if (!picked || (direction !== -1 && direction !== 1)) return original;
  index = indexOfRef(picked, options);
  if (index < 0) return original;
  ranges = stopRanges(picked);
  at = rangeOfIndex(ranges, index);
  range = ranges[at];

  if (options.unit !== "stop" && range.end - range.start > 1) {
    target = index + direction;
    if (target < range.start || target >= range.end) return original;
    state = copyState(original);
    item = state.picked[index];
    state.picked[index] = state.picked[target];
    state.picked[target] = item;
    return state;
  }

  neighbor = ranges[at + direction];
  if (!neighbor) return original;
  state = copyState(original);
  block = state.picked.splice(range.start, range.end - range.start);
  target = direction === -1 ? neighbor.start : neighbor.end - block.length;
  Array.prototype.splice.apply(state.picked, [target, 0].concat(block));
  normalizeGroups(state.picked);
  return state;
}

function pickKeySet(pickKeys) {
  var set = {};
  var i;
  var list = Array.isArray(pickKeys) ? pickKeys : [];
  for (i = 0; i < list.length; i += 1) {
    if (typeof list[i] === "string") set[list[i]] = true;
  }
  return set;
}

function itemPickKey(item) {
  return typeof item.pickKey === "string" ? item.pickKey : pickKeyFor(item);
}

// 고른 창들을 새 묶음 하나로 병합. 목록 순서 유지, 위치는 첫 번째로 고른 창이 있던 차례의 앞
// 다른 묶음에 있던 창은 그 묶음에서 빠지고, 남은 창이 하나뿐인 묶음은 normalizeGroups 가 정리
function groupPicked(options) {
  var original = options && options.state;
  var picked = original && Array.isArray(original.picked) ? original.picked : null;
  var wanted = pickKeySet(options && options.pickKeys);
  var chosen = [];
  var i;
  var state;
  var ranges;
  var at;
  var rest = [];
  var block = [];
  var used = {};
  var name;

  if (!picked) return original;
  for (i = 0; i < picked.length; i += 1) {
    if (wanted[itemPickKey(picked[i])]) chosen.push(i);
  }
  if (chosen.length < 2) return original;

  state = copyState(original);
  ranges = stopRanges(state.picked);
  at = ranges[rangeOfIndex(ranges, chosen[0])].start;
  for (i = 0; i < state.picked.length; i += 1) {
    if (groupOf(state.picked[i])) used[groupOf(state.picked[i])] = true;
  }
  name = freshGroupName(used);
  for (i = 0; i < state.picked.length; i += 1) {
    if (chosen.indexOf(i) >= 0) {
      state.picked[i].group = name;
      block.push(state.picked[i]);
    } else {
      rest.push(state.picked[i]);
    }
  }
  state.picked = rest.slice(0, at).concat(block, rest.slice(at));
  normalizeGroups(state.picked);
  return state;
}

// 고른 창들을 각자의 묶음에서 빼서 그 묶음 바로 뒤의 혼자인 차례로 이동. 고른 창끼리의 순서 유지
function leavePicked(options) {
  var original = options && options.state;
  var picked = original && Array.isArray(original.picked) ? original.picked : null;
  var wanted = pickKeySet(options && options.pickKeys);
  var state;
  var i;
  var ranges;
  var range;
  var item;
  var changed = false;

  if (!picked) return original;
  state = copyState(original);
  // 뒤에서부터 빼야 같은 묶음의 여러 창이 원래 순서대로 묶음 뒤에 선다
  for (i = state.picked.length - 1; i >= 0; i -= 1) {
    if (!wanted[itemPickKey(state.picked[i])] || !groupOf(state.picked[i])) continue;
    ranges = stopRanges(state.picked);
    range = ranges[rangeOfIndex(ranges, i)];
    if (range.end - range.start < 2) continue;
    item = state.picked.splice(i, 1)[0];
    delete item.group;
    state.picked.splice(range.end - 1, 0, item);
    changed = true;
  }
  if (!changed) return original;
  normalizeGroups(state.picked);
  return state;
}

// 그 창이 속한 묶음 전체를 혼자인 차례로 분리. 순서 유지
function ungroup(options) {
  var original = options && options.state;
  var picked = original && Array.isArray(original.picked) ? original.picked : null;
  var index;
  var ranges;
  var range;
  var state;
  var i;

  if (!picked) return original;
  index = indexOfRef(picked, options);
  if (index < 0) return original;
  ranges = stopRanges(picked);
  range = ranges[rangeOfIndex(ranges, index)];
  if (range.end - range.start < 2) return original;

  state = copyState(original);
  for (i = range.start; i < range.end; i += 1) delete state.picked[i].group;
  return state;
}

// 이 앱의 창 가운데 저장된 선택이 가리키는 창의 순번. 못 찾으면 -1
// candidates: { id: 창 번호(macOS CGWindowID·Windows HWND), title, bounds: [x, y, ...] }
// 같은 제목의 창이 여럿일 수 있어(에뮬레이터 분리 창 등) 창 번호를 먼저 보고, 제목은 하나뿐일 때만 쓴다
function findOwnWindow(target, candidates) {
  var list = Array.isArray(candidates) ? candidates : [];
  var ids = [];
  var i;
  var titleHits = [];
  var samePlace = function (item) {
    return validBounds(target.bounds) && Array.isArray(item.bounds)
      && item.bounds[0] === target.bounds[0] && item.bounds[1] === target.bounds[1];
  };
  if (!target) return -1;
  if (isInteger(target.cgId)) ids.push(target.cgId);
  if (isInteger(target.id)) ids.push(target.id);
  for (i = 0; i < list.length; i += 1) {
    if (isInteger(list[i].id) && ids.indexOf(list[i].id) >= 0) return i;
  }
  for (i = 0; i < list.length; i += 1) {
    if (list[i].title === target.matchTitle) {
      if (samePlace(list[i])) return i;
      titleHits.push(i);
    }
  }
  if (titleHits.length === 1) return titleHits[0];
  for (i = 0; i < list.length; i += 1) {
    if (samePlace(list[i])) return i;
  }
  return -1;
}

// 전환 한 번에 올릴 차례 목록. targets: 선택 순서의 { id, group }
// 차례 id 는 맨 앞 창의 id. 묶음이 없으면 차례 목록과 창 목록이 같음
function planStops(targets) {
  var list = Array.isArray(targets) ? targets.filter(function (item) { return item && item.id != null; }) : [];
  var ranges = stopRanges(list);
  var stops = [];
  var i;
  var j;
  var members;
  for (i = 0; i < ranges.length; i += 1) {
    members = [];
    for (j = ranges[i].start; j < ranges[i].end; j += 1) members.push(list[j].id);
    stops.push({ id: members[0], members: members });
  }
  return { ordered: stops.map(function (stop) { return stop.id; }), stops: stops };
}

// 창 id 에 해당하는 차례 id. 어느 차례에도 없으면 null
function stopIdOf(plan, memberId) {
  var stops = plan && Array.isArray(plan.stops) ? plan.stops : [];
  var i;
  if (memberId == null) return null;
  for (i = 0; i < stops.length; i += 1) {
    if (indexOfStrict(stops[i].members, memberId) >= 0) return stops[i].id;
  }
  return null;
}

function indexOfStrict(values, wanted) {
  var i;
  for (i = 0; i < values.length; i += 1) {
    if (values[i] === wanted) return i;
  }
  return -1;
}

function selectTarget(options) {
  var ordered = options && Array.isArray(options.ordered) ? options.ordered : [];
  var resolved = options && Array.isArray(options.resolved) ? options.resolved : [];
  var direction = options && options.dir === -1 ? -1 : 1;
  var start;
  var index;
  var step;

  if (ordered.length === 0 || resolved.length === 0) return { id: null };
  start = indexOfStrict(ordered, options ? options.front : null);
  // 앞 창을 읽지 못했을 때만 cursor로 이어 간다. 앞 창을 알고 그것이 목록 밖이면
  // 정의대로 첫 창부터 시작한다(R9). front 키가 없는 호출도 읽지 못한 것으로 본다.
  if (start < 0 && options && options.front == null) {
    start = indexOfStrict(ordered, options.cursor);
  }

  for (step = 1; step <= ordered.length; step += 1) {
    if (start < 0) {
      index = direction === 1 ? step - 1 : ordered.length - step;
    } else {
      index = (start + direction * step) % ordered.length;
      if (index < 0) index += ordered.length;
    }
    if (indexOfStrict(resolved, ordered[index]) >= 0) return { id: ordered[index] };
  }
  return { id: null };
}

function normalizeStoredItem(source) {
  var item;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  if (typeof source.matchApp !== "string" || typeof source.matchTitle !== "string") return null;
  if (!isInteger(source.pid) || source.pid < 0) return null;
  if (!validBounds(source.bounds)) return null;

  item = {
    cgId: source.cgId === null || isInteger(source.cgId) ? source.cgId : null,
    pid: source.pid,
    pidStart: typeof source.pidStart === "string" ? source.pidStart.slice(0, 400) : "",
    matchApp: source.matchApp.slice(0, 400),
    matchTitle: source.matchTitle.slice(0, 400),
    ordinal: isInteger(source.ordinal) && source.ordinal >= 1 ? source.ordinal : 1,
    bounds: source.bounds.slice(),
  };
  if (typeof source.appKey === "string" && source.appKey) item.appKey = source.appKey.slice(0, 400);
  if (groupOf(source)) item.group = source.group.slice(0, GROUP_LIMIT);
  item.pickKey = pickKeyFor(item);
  return item;
}

function normalizeSerializableItem(source) {
  var value = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  var appKey = effectiveAppKey(value);
  var item = {
    cgId: value.cgId === null || isInteger(value.cgId) ? value.cgId : null,
    pid: isInteger(value.pid) ? value.pid : 0,
    pidStart: typeof value.pidStart === "string" ? value.pidStart.slice(0, 400) : "",
    matchApp: typeof value.matchApp === "string" ? value.matchApp.slice(0, 400) : "",
    matchTitle: typeof value.matchTitle === "string" ? value.matchTitle.slice(0, 400) : "",
    ordinal: isInteger(value.ordinal) && value.ordinal >= 1 ? value.ordinal : 1,
    bounds: validBounds(value.bounds) ? value.bounds.slice() : [0, 0, 0, 0],
  };
  if (appKey) item.appKey = appKey.slice(0, 400);
  if (groupOf(value)) item.group = value.group.slice(0, GROUP_LIMIT);
  item.pickKey = pickKeyFor(item);
  return item;
}

function deserialize(raw) {
  var source = raw;
  var picked = [];
  var limit;
  var i;
  var item;

  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch (error) {
      return emptyState();
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source) || source.version !== 1) return emptyState();
  if (!Array.isArray(source.picked)) return emptyState();

  limit = Math.min(source.picked.length, 200);
  for (i = 0; i < limit; i += 1) {
    item = normalizeStoredItem(source.picked[i]);
    if (item) picked.push(item);
  }
  return {
    version: 1,
    picked: normalizeGroups(picked),
    cursor: isInteger(source.cursor) ? source.cursor : null,
  };
}

function serialize(state) {
  var source = state && Array.isArray(state.picked) ? state.picked : [];
  var picked = [];
  var limit = Math.min(source.length, 200);
  var i;

  for (i = 0; i < limit; i += 1) picked.push(normalizeSerializableItem(source[i]));
  return {
    version: 1,
    picked: normalizeGroups(picked),
    cursor: state && isInteger(state.cursor) ? state.cursor : null,
  };
}

module.exports = {
  assignOrdinals: assignOrdinals,
  matchWindow: matchWindow,
  reconcile: reconcile,
  pruneDeadProcesses: pruneDeadProcesses,
  pick: pick,
  unpick: unpick,
  movePicked: movePicked,
  groupPicked: groupPicked,
  leavePicked: leavePicked,
  ungroup: ungroup,
  findOwnWindow: findOwnWindow,
  planStops: planStops,
  stopIdOf: stopIdOf,
  selectTarget: selectTarget,
  serialize: serialize,
  deserialize: deserialize,
};
