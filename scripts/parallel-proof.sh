#!/bin/bash
# 기능마다 병렬 수정이 실제로 되는지 실험으로 확인한다.
#
# 필요조건(파일 배타 소유·이름 충돌 없음)은 스위트가 검사한다. 이 스크립트는 그다음을 본다.
# 서로를 본 적 없는 두 사람이 각자 자기 기능만 고치고 합쳤을 때 충돌 없이 둘 다 남는가.
#
# 고르는 기능: archive 와 sourcecontrol. 둘 다 화면·페이지·서버 짝이 있어 겹칠 여지가 가장 크다.
# 손대는 것: 화면 문구 한 줄과 자기 페이지 한 줄. 실제 수정 작업과 같은 형태다.
#
# 되돌리는 것: 전부 사본 안에서만 일어난다. 이 저장소의 작업 트리는 건드리지 않는다.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/iris-parallel-proof.$$"
trap 'rm -rf "$WORK" "${TMPDIR:-/tmp}/iris-parallel-merge.$$.log"' EXIT

# git 이 안 담는 자산(node_modules·web/vendor)까지 와야 스위트가 돈다. 워크트리로 뽑으면 빠진다.
cp -Rc "$REPO" "$WORK"
cd "$WORK"
git checkout HEAD -- .
BASE=$(git rev-parse HEAD)

# ── 작업자 A: archive 만
git checkout -q -b workerA "$BASE"
python3 - <<'PY'
import io
p = "web/js/devtool/archive.js"
s = io.open(p, encoding="utf-8").read()
assert s.count('<span class="scr-bar-title">보관함</span>') == 1, "archive 문구 앵커가 바뀌었다"
io.open(p, "w", encoding="utf-8").write(
    s.replace('<span class="scr-bar-title">보관함</span>',
              '<span class="scr-bar-title">보관함 A표식</span>', 1))
p2 = "web/css/04-archive.css"
t = io.open(p2, encoding="utf-8").read()
io.open(p2, "w", encoding="utf-8").write(t + "\n.ar-empty { letter-spacing: .01em; }\n")
PY
git add -A && git commit -q -m "workerA: archive 문구·지면"

# ── 작업자 B: sourcecontrol 만. A 를 참조하지 않는다 (BASE 에서 갈라진다)
git checkout -q -b workerB "$BASE"
python3 - <<'PY'
import io
p = "web/js/devtool/source-control.js"
s = io.open(p, encoding="utf-8").read()
assert s.count('<span class="sc-title">소스 제어</span>') == 1, "source-control 문구 앵커가 바뀌었다"
io.open(p, "w", encoding="utf-8").write(
    s.replace('<span class="sc-title">소스 제어</span>',
              '<span class="sc-title">소스 제어 B표식</span>', 1))
p2 = "web/css/07-git.css"
t = io.open(p2, encoding="utf-8").read()
io.open(p2, "w", encoding="utf-8").write(t + "\n.sc-empty { letter-spacing: .01em; }\n")
PY
git add -A && git commit -q -m "workerB: source-control 문구·지면"

# ── 합치기
git checkout -q workerA
echo "== 합치기"
MLOG="${TMPDIR:-/tmp}/iris-parallel-merge.$$.log"
if git merge --no-edit workerB >"$MLOG" 2>&1 ; then
  echo "   충돌 없음"
else
  echo "   !! 충돌"
  git diff --name-only --diff-filter=U | sed 's/^/      /'
  exit 1
fi

echo "== 두 변경이 둘 다 살아 있는가"
printf '   archive       %s\n' "$(grep -c '보관함 A표식' web/js/devtool/archive.js)"
printf '   sourcecontrol %s\n' "$(grep -c '소스 제어 B표식' web/js/devtool/source-control.js)"

echo "== 합친 트리에서 스위트"
IRIS_STATE_DIR="$HOME/.iris-dev" IRIS_PORT=4291 PORT=4291 node bin/smoke.mjs 2>&1 \
  | grep -E "FAIL|^결과:" | sed 's/^/   /'
