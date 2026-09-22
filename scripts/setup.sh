#!/bin/bash
# 처음 켜는 사람이 실행하는 단 하나의 명령.
#
# 이 파일이 있는 이유: herdr 를 설치하지 않고 앱을 켜면 터미널·에이전트·스페이스가 빈 화면으로
# 뜨고, 사용자는 그것이 고장인지 설치가 덜 된 것인지 알 수 없다. 문서에 적는 것만으로는
# 강제되지 않으므로 여기서 실제로 설치한다.
#
# 원칙 둘.
#  (1) 다른 사람의 컴퓨터에 무언가를 설치할 때는 무엇을 하는지 먼저 보여 준다. 이 스크립트는 실행할
#      명령을 그대로 화면에 적고 나서 실행한다.
#  (2) 검증된 경로를 먼저 쓴다. herdr는 homebrew-core 정식 포뮬러라 체크섬이 붙은 bottle 을 받는다.
#      인터넷에서 받은 스크립트를 셸에 바로 먹이는 길은 그것이 안 될 때의 대비책이고, 그때는
#      반드시 물어본다(--yes 로 넘길 수 있다).
#
# 몇 번을 실행해도 결과가 같다. 이미 있는 것은 건너뛰고 무엇이 이미 있었는지 알려 준다.
set -uo pipefail
cd "$(dirname "$0")/.."

YES=0
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --check)  CHECK=1 ;;
    --help|-h)
      echo "쓰기: ./setup [--yes] [--check]"
      echo "  --yes    묻지 않고 진행합니다"
      echo "  --check  아무것도 설치하지 않고 무엇이 준비됐는지만 봅니다"
      exit 0 ;;
    *) echo "모르는 옵션: $arg (./setup --help)"; exit 2 ;;
  esac
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { echo "  ✅ $*"; }
info() { echo "  ${DIM}$*${OFF}"; }
warn() { echo "  ⚠️  $*"; }
bad()  { echo "  ❌ $*"; }
step() { echo; echo "${BOLD}$*${OFF}"; }

# 실행할 명령을 먼저 보여 주고 실행한다. 무엇이 돌아가는지 모른 채 지나가는 줄이 없어야 한다.
run() {
  echo "  ${DIM}\$ $*${OFF}"
  "$@"
}

# 예/아니오. --yes 면 묻지 않고 예. 사람이 없는 환경(파이프)에서는 묻지 않고 아니오로 둔다.
# 대답을 받을 수 없는데 설치를 진행하면 안 된다.
ask() {
  [ "$YES" = "1" ] && return 0
  [ -t 0 ] || return 1
  local reply
  read -r -p "  $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

FAIL=0
note_fail() { FAIL=1; }

echo
echo "${BOLD}Iris 설치${OFF}"
echo "${DIM}필요한 것을 확인하고, 없으면 깔고, 앱까지 만들어 넣습니다.${OFF}"
[ "$CHECK" = "1" ] && info "확인만 합니다 — 아무것도 설치하지 않습니다."

# ── 1. 이 컴퓨터가 맞는가 ────────────────────────────────────────────────────
step "1/6  이 컴퓨터에서 돌 수 있는지 봅니다"
if [ "$(uname -s)" != "Darwin" ]; then
  bad "Iris는 지금 macOS에서만 돕니다. (이 컴퓨터: $(uname -s))"
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  bad "Apple Silicon(M1 이상) 맥이 필요합니다. (이 컴퓨터: $(uname -m))"
  exit 1
fi
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$MACOS_MAJOR" -lt 14 ]; then
  bad "macOS 14 이상이 필요합니다. (이 컴퓨터: $(sw_vers -productVersion))"
  echo "     시스템 설정 → 일반 → 소프트웨어 업데이트에서 올린 뒤 다시 실행하세요."
  exit 1
fi
ok "macOS $(sw_vers -productVersion), Apple Silicon"

# ── 2. Node와 pnpm ──────────────────────────────────────────────────────────
step "2/6  Node.js와 pnpm"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 22 ]; then ok "Node.js $(node -v)"; NODE_OK=1
  else warn "Node.js $(node -v) — 22 이상이 필요합니다"; fi
else
  warn "Node.js가 없습니다"
fi
# --check 는 설치하지 않으므로 여기서 빠진 것을 실패로 세어야 "전부 준비" 가 거짓이 되지 않는다.
[ "$NODE_OK" = "0" ] && [ "$CHECK" = "1" ] && note_fail
if [ "$NODE_OK" = "0" ] && [ "$CHECK" = "0" ]; then
  if command -v brew >/dev/null 2>&1; then
    if ask "Homebrew로 Node.js를 깔까요?"; then
      run brew install node@22 && run brew link --overwrite --force node@22
    fi
  else
    echo "     https://nodejs.org 에서 LTS를 받아 설치한 뒤 이 창을 닫고 다시 여세요."
  fi
  command -v node >/dev/null 2>&1 && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${NODE_MAJOR:-0}" -ge 22 ] && { ok "Node.js $(node -v)"; NODE_OK=1; } || { bad "Node.js 22 이상이 아직 없습니다"; note_fail; }
fi

if command -v pnpm >/dev/null 2>&1; then
  # package.json 의 packageManager 가 버전을 정한다. 9.2 미만은 그 버전과 다르다고 멈추고, 9.x 는
  # 자기 버전으로 돌며(잠금 파일 호환), 10 이상은 정해진 버전을 받아 돈다.
  case "$(pnpm -v 2>/dev/null)" in
    "") bad "pnpm이 있지만 버전을 확인하지 못했습니다"; note_fail ;;
    [0-8].*|9.0.*|9.1.*) warn "pnpm $(pnpm -v) — 9.2 이상이어야 합니다(corepack enable pnpm 또는 npm i -g pnpm@9)"; note_fail ;;
    *) ok "pnpm $(pnpm -v)" ;;
  esac
elif [ "$CHECK" = "1" ]; then
  warn "pnpm이 없습니다"; note_fail
elif [ "$NODE_OK" = "1" ]; then
  info "pnpm이 없어 Node에 딸린 corepack으로 켭니다."
  run corepack enable pnpm || true
  command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm -v)" || { bad "pnpm을 켜지 못했습니다 — 'npm i -g pnpm'을 해 보세요"; note_fail; }
fi

# ── 3. herdr ────────────────────────────────────────────────────────────────
step "3/6  herdr — 터미널과 에이전트 세션을 맡는 프로그램"
info "Iris의 터미널·에이전트·스페이스 목록이 여기서 옵니다. 없으면 그 화면들이 빕니다."

herdr_path() {
  command -v herdr 2>/dev/null && return 0
  [ -x "$HOME/.local/bin/herdr" ] && { echo "$HOME/.local/bin/herdr"; return 0; }
  return 1
}

if HERDR="$(herdr_path)"; then
  ok "이미 있습니다 — $("$HERDR" --version 2>/dev/null || echo herdr) ($HERDR)"
elif [ "$CHECK" = "1" ]; then
  warn "herdr가 없습니다 — ./setup 을 옵션 없이 돌리면 깔아 줍니다"; note_fail
else
  INSTALLED=0
  if command -v brew >/dev/null 2>&1; then
    info "Homebrew의 정식 목록(homebrew-core)에 있습니다. 내려받은 파일의 체크섬을 brew가 확인합니다."
    run brew install herdr && INSTALLED=1 || warn "brew로 깔지 못했습니다 — 다른 길을 봅니다"
  fi
  if [ "$INSTALLED" = "0" ]; then
    echo
    info "Homebrew가 없거나 실패했습니다. herdr가 공식으로 안내하는 설치 명령은 이것입니다:"
    echo "       curl -fsSL https://herdr.dev/install.sh | sh"
    info "인터넷에서 받은 스크립트를 그대로 실행하는 방식이라, 묻고 나서 합니다."
    if ask "위 명령을 실행할까요?"; then
      curl -fsSL https://herdr.dev/install.sh | sh && INSTALLED=1
    else
      echo "     건너뜁니다. 나중에 직접 깔고 './setup' 을 다시 돌리면 됩니다."
    fi
  fi
  if HERDR="$(herdr_path)"; then
    ok "herdr 준비됨 — $("$HERDR" --version 2>/dev/null || echo herdr) ($HERDR)"
  else
    bad "herdr가 아직 없습니다."
    echo "     Iris는 뜨지만 터미널·에이전트·스페이스 화면이 빈 채로 보입니다."
    echo "     https://herdr.dev/docs/install/ 을 보고 깐 뒤 './setup' 을 다시 돌리세요."
    note_fail
  fi
fi

# ── 4. 부품 내려받기 ────────────────────────────────────────────────────────
step "4/6  Iris가 쓰는 부품을 내려받습니다"
if [ "$CHECK" = "1" ]; then
  if [ -d node_modules ] && [ -d web/vendor ]; then ok "이미 있습니다"; else warn "아직 없습니다 (pnpm install 필요)"; note_fail; fi
elif [ "$FAIL" = "1" ]; then
  warn "앞 단계가 끝나지 않아 건너뜁니다"
else
  run pnpm install || { bad "부품을 받지 못했습니다 — 인터넷 연결을 확인하고 다시 돌려 보세요"; exit 1; }
  ok "부품 준비됨"
fi

# ── 5. 앱 만들고 넣기 ───────────────────────────────────────────────────────
step "5/6  앱을 만들어 /Applications 에 넣습니다"
if [ "$CHECK" = "1" ]; then
  [ -d /Applications/Iris.app ] && ok "이미 설치돼 있습니다" || { warn "아직 설치되지 않았습니다"; note_fail; }
elif [ "$FAIL" = "1" ]; then
  warn "앞 단계가 끝나지 않아 건너뜁니다"
else
  info "1~2분 걸립니다. 앱이 이미 떠 있다면, 다 만든 뒤에 잠깐만 껐다 켭니다."
  run bash scripts/install-app.sh || { bad "앱을 만들지 못했습니다"; exit 1; }
fi

# ── 6. 에이전트 연결 ────────────────────────────────────────────────────────
# Iris 의 브라우저·앱 도구는 MCP 로 나간다. 등록은 각 CLI 의 사용자 설정을 고치는 일이라 묻고
# 나서 하고, CLI 가 없는 쪽은 건너뛴다(Iris 자체는 둘 없이도 돈다). 등록하는 경로는 이 저장소의
# bin/iris-mcp.mjs 다. 설치된 앱 안의 사본은 asar 에 묶여 있어 밖에서 실행할 수 없다.
# herdr 가 없어도 여기는 실행된다. 등록에 필요한 것은 저장소 경로뿐이고, 다시 실행해도 같다.
step "6/6  에이전트 연결 — Claude Code·Codex 에 Iris 도구를 등록합니다"
IRIS_MCP="$(pwd)/bin/iris-mcp.mjs"

# 등록된 경로. 이름이 iris-mcp 가 아니어도 인자가 iris-mcp.mjs 를 가리키면 등록된 것이다.
# 다른 이름으로 등록해 둔 경우에 "없다" 고 하면 같은 서버가 둘이 된다. 이름별 조회가 빠르니
# 그것을 먼저 보고, 없으면 목록에서 찾는다(claude 는 없어도 exit 0 이라 exit 로는 못 가른다).
# 다른 checkout 이어도 파일이 있으면 등록된 것으로 본다. 파일이 없으면(저장소를 옮겼거나
# 지웠다) 이 저장소로 다시 등록한다. claude 는 같은 이름을 덮지 않으므로 먼저 뺀다.
# 조회 결과는 REG(인자 줄)·IRIS_NAME(등록 이름) 두 전역에 둔다. $( ) 서브셸에서 바꾼 이름은
# 밖으로 안 나온다. 이름이 무엇이든 인자가 이 파일(bin/iris-mcp.mjs)을 가리켜야 Iris 등록이다.
# `iris-mcp` 이름이 다른 서버에 쓰이고 있으면 건드리지 않는다. 그 서버의 옵션·환경변수를 지우게 된다.
IRIS_NAME=iris-mcp
REG=""
TAKEN=""   # iris-mcp 이름이 Iris 아닌 것에 쓰이고 있을 때 그 인자 줄
is_iris_args() { case "$1" in *'/bin/iris-mcp.mjs'|*'/bin/iris-mcp.mjs '*) return 0 ;; *) return 1 ;; esac; }
claude_iris_get()  { claude mcp get iris-mcp 2>/dev/null; }
codex_iris_get()   { codex mcp get iris-mcp 2>/dev/null; }
claude_iris_args() { claude_iris_get | sed -n 's/^[[:space:]]*Args: //p' | head -1; }
codex_iris_args()  { codex_iris_get | sed -n 's/^[[:space:]]*args: //p' | head -1 | grep -vx -- - || true; }
find_iris() {   # $1 = claude|codex
  IRIS_NAME=iris-mcp; REG=""; TAKEN=""
  local out args line; out="$(${1}_iris_get)"
  # 없는 이름에도 claude 는 안내문을, codex 는 오류를 출력하므로 첫 줄이 이름일 때만 등록이다.
  case "$1" in claude) [ "${out%%$'\n'*}" = "iris-mcp:" ] || out="" ;; codex) [ "${out%%$'\n'*}" = "iris-mcp" ] || out="" ;; esac
  if [ -n "$out" ]; then
    args="$(${1}_iris_args)"
    if is_iris_args "$args"; then REG="$args"
    # 인자가 아니라 명령 자리에 이 파일을 둔 등록도 Iris 다. 저장소 경로에 공백이 있으면
    # `[^ ]*` 로는 그 앞부분이 잘려 나가므로, 지금 저장소 경로 그대로가 줄 안에 있는지부터
    # 문자열로 먼저 본다(실제로 발생한 사례는 없고, 코드 정적 검토로 찾음).
    elif printf '%s\n' "$out" | grep -q '/bin/iris-mcp\.mjs'; then
      if printf '%s\n' "$out" | grep -qF -- "$IRIS_MCP"; then REG="$IRIS_MCP"
      else REG="$(printf '%s\n' "$out" | grep -o '[^ ]*/bin/iris-mcp\.mjs' | head -1)"; fi
    # 인자 줄이 없는 등록(HTTP 서버 등)도 그 이름을 쓰고 있다는 뜻이다.
    else TAKEN="${args:-인자 없음}"; fi
    return 0
  fi
  line="$($1 mcp list 2>/dev/null | grep -F '/bin/iris-mcp.mjs' | head -1)"
  [ -z "$line" ] && return 0
  # claude 목록은 `이름: 명령 …` 이고 플러그인 서버 이름에는 `:` 가 들어가므로 `: ` 로 자른다.
  case "$1" in claude) IRIS_NAME="${line%%: *}" ;; codex) IRIS_NAME="${line%% *}" ;; esac
  if printf '%s' "$line" | grep -qF -- "$IRIS_MCP"; then REG="$IRIS_MCP"
  else REG="$(printf '%s' "$line" | grep -o '[^ ]*/bin/iris-mcp\.mjs' | head -1)"; fi
}
# 조회 줄은 인자 전부다. 손으로 node 옵션을 앞에 붙여 등록했으면 마지막 인자가 경로다. 어느
# 쪽이든 절대 경로일 때만 믿는다. 상대 경로는 지금 폴더의 파일과 우연히 맞아 잘못된 통과가 된다.
mcp_file_exists() {
  case "$1" in /*) [ -f "$1" ] && return 0 ;; esac
  case "${1##* }" in /*) [ -f "${1##* }" ] ;; *) return 1 ;; esac
}

if ! command -v claude >/dev/null 2>&1; then
  info "Claude Code 가 없어 건너뜁니다."
else
  find_iris claude
  if [ -n "$REG" ] && mcp_file_exists "$REG"; then
    ok "Claude Code 에 iris-mcp 가 등록돼 있습니다 ($REG)"
  elif [ -n "$TAKEN" ]; then
    warn "Claude Code 의 iris-mcp 이름을 다른 서버가 쓰고 있어 건드리지 않습니다 ($TAKEN) — 그 등록을 옮기거나 지운 뒤 ./setup 을 다시 돌리세요"
    note_fail
  elif [ "$CHECK" = "1" ]; then
    if [ -n "$REG" ]; then warn "Claude Code 에 등록된 iris-mcp 경로에 파일이 없습니다 ($REG) — ./setup 을 옵션 없이 돌리면 이 저장소로 다시 등록합니다"
    else warn "Claude Code 에 iris-mcp 가 없습니다 — ./setup 을 옵션 없이 돌리면 등록해 줍니다"; fi
    note_fail
  else
    [ -n "$REG" ] && info "등록된 경로($REG)에 파일이 없어 이 저장소로 다시 등록합니다."
    info "Claude Code 의 사용자 설정에 MCP 서버 하나를 더합니다(claude mcp remove iris-mcp -s user 로 뺄 수 있습니다)."
    info "\$ claude mcp add --scope user iris-mcp -- node $IRIS_MCP"
    if ask "Claude Code 에 iris-mcp 를 등록할까요?"; then
      { [ -z "$REG" ] || run claude mcp remove "$IRIS_NAME" -s user; } && run claude mcp add --scope user iris-mcp -- node "$IRIS_MCP" \
        && [ "$(claude_iris_args)" = "$IRIS_MCP" ] && ok "Claude Code 에 등록됨" || { bad "Claude Code 에 등록하지 못했습니다"; note_fail; }
    else
      echo "     건너뜁니다. 나중에 './setup' 을 다시 돌리면 됩니다."
    fi
  fi
fi

if ! command -v codex >/dev/null 2>&1; then
  info "Codex 가 없어 건너뜁니다."
else
  find_iris codex
  if [ -n "$REG" ] && mcp_file_exists "$REG"; then
    ok "Codex 에 iris-mcp 가 등록돼 있습니다 ($REG)"
  elif [ -n "$TAKEN" ]; then
    warn "Codex 의 iris-mcp 이름을 다른 서버가 쓰고 있어 건드리지 않습니다 ($TAKEN) — 그 등록을 옮기거나 지운 뒤 ./setup 을 다시 돌리세요"
    note_fail
  elif [ "$CHECK" = "1" ]; then
    if [ -n "$REG" ]; then warn "Codex 에 등록된 iris-mcp 경로에 파일이 없습니다 ($REG) — ./setup 을 옵션 없이 돌리면 이 저장소로 다시 등록합니다"
    else warn "Codex 에 iris-mcp 가 없습니다 — ./setup 을 옵션 없이 돌리면 등록해 줍니다"; fi
    note_fail
  else
    [ -n "$REG" ] && info "등록된 경로($REG)에 파일이 없어 이 저장소로 다시 등록합니다."
    info "Codex 설정(config.toml)에 MCP 서버 하나를 더합니다(codex mcp remove iris-mcp 로 뺄 수 있습니다)."
    info "\$ codex mcp add iris-mcp -- node $IRIS_MCP"
    if ask "Codex 에 iris-mcp 를 등록할까요?"; then
      { [ -z "$REG" ] || [ "$IRIS_NAME" = iris-mcp ] || run codex mcp remove "$IRIS_NAME"; } && run codex mcp add iris-mcp -- node "$IRIS_MCP" \
        && [ "$(codex_iris_args)" = "$IRIS_MCP" ] && ok "Codex 에 등록됨" || { bad "Codex 에 등록하지 못했습니다"; note_fail; }
    else
      echo "     건너뜁니다. 나중에 './setup' 을 다시 돌리면 됩니다."
    fi
  fi
fi

# 에이전트가 Iris 안에서 자식 세션을 띄우는 방법을 담은 스킬 파일. 설치된 앱의 실행기 경로를
# 담으므로 앱이 있어야 하고, 5단계의 install-app.sh 가 이미 깔았으므로 여기서는 확인이 주다.
if [ -d /Applications/Iris.app ]; then
  if [ "$CHECK" = "1" ]; then
    node scripts/install-agent-context.mjs --app /Applications/Iris.app --check >/dev/null \
      && ok "에이전트 스킬 파일(iris-agent-context)이 최신입니다" \
      || { warn "에이전트 스킬 파일이 없거나 낡았습니다 — ./setup 을 옵션 없이 돌리면 맞춰 줍니다"; note_fail; }
  else
    run node scripts/install-agent-context.mjs --app /Applications/Iris.app \
      && ok "에이전트 스킬 파일 준비됨" || { bad "에이전트 스킬 파일을 놓지 못했습니다"; note_fail; }
  fi
else
  info "앱이 아직 없어 에이전트 스킬 파일은 앱을 넣은 뒤에 봅니다."
fi

echo
if [ "$CHECK" = "1" ]; then
  if [ "$FAIL" = "0" ]; then echo "${BOLD}전부 준비돼 있습니다.${OFF}"; else echo "${BOLD}아직 덜 된 것이 있습니다 — 위의 ⚠️·❌ 줄을 보세요.${OFF}"; fi
  exit "$FAIL"
fi
if [ "$FAIL" = "0" ]; then
  echo "${BOLD}끝났습니다.${OFF} Iris가 열렸습니다."
  echo "${DIM}다음부터는 런치패드나 Spotlight에서 'Iris'로 열면 됩니다.${OFF}"
  echo "${DIM}뭔가 이상하면 './setup --check' 로 무엇이 빠졌는지 볼 수 있습니다.${OFF}"
else
  echo "${BOLD}일부가 덜 됐습니다.${OFF} 위의 ⚠️·❌ 줄이 무엇을 해야 하는지 알려 줍니다."
fi
exit "$FAIL"
