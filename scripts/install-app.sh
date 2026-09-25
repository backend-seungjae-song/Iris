#!/bin/bash
# 소스를 앱으로 만들어 /Applications/Iris.app을 갈아 끼운다.
#
# 이 저장소는 소스에서 띄운 개발 인스턴스와 설치된 앱이 동시에 돌 수 있다. 둘이 같은
# 포트에 붙으면 실행기 등록을 서로 덮어써, 명령이 어느 쪽으로 갔는지 모른 채 "있는 명령이
# 없다"고 돌아온다. 그래서 개발은 자기 포트(pnpm dev)로 돌리고, 설치된 앱은 이 스크립트로만
# 고친다. 손으로 quit·build·ditto를 반복하면 하나를 빠뜨린 채 옛 코드를 시험하게 된다.
#
# 순서가 중요하다. 빌드를 먼저 하고, 다 만든 뒤에만 끈다. 끄고 나서 빌드하면 빌드가
# 도는 1~2분 내내 앱을 쓸 수 없다.
# 빌드는 dist/에만 쓰므로 앱이 떠 있어도 방해받지 않는다. 이렇게 하면 꺼져 있는 시간이
# 교체·재실행에 드는 몇 초로 줄고, 빌드가 실패하면 아예 끄지도 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=/Applications/Iris.app
BUILT=dist/mac-arm64/Iris.app

# 이름이 겹치는 미사용 사본이 있으면 어느 쪽을 고쳤는지 착각한다. 쓰이지 않는 사본을 고치고
# 빌드하면 "고쳤는데 그대로"인 앱이 나가므로 빌드 전에 잡는다.
echo "0/6  사본 검사"
node scripts/check-shipped.mjs pre

echo "1/6  빌드 (앱은 켜둔 채)"
npx electron-builder --mac --arm64 >/dev/null
[ -d "$BUILT" ] || { echo "빌드 산출물이 없다: $BUILT"; exit 1; }

# 사본이 없어도 다른 이유로 빠질 수 있다. 결과물 자체를 보고, 다르면 앱을 끄기 전에 멈춘다.
echo "2/6  결과물 대조"
node scripts/check-shipped.mjs post
/usr/bin/codesign --verify --deep --strict "$BUILT"

# 설치된 앱은 개발 환경 변수를 물려받지 않는다. 이 스크립트는 pnpm 안에서 돌고 `open`은 지금 셸의
# 환경을 앱에 그대로 물려준다. 개발용으로 띄웠던 셸에서 실행해 흘러든 REMOTE=1 로 설치된 앱이
# 127.0.0.1 이 아니라 0.0.0.0 에 붙은 적이 있다. 서버 준비 확인도 같은 환경에서 해야 설치 앱의
# 포트·상태 폴더를 본다.
installed_env() { env -u IRIS_PORT -u IRIS_STATE_DIR -u PORT -u REMOTE -u HOST "$@"; }
running() { pgrep -f "$APP/Contents/MacOS/Iris" >/dev/null; }
# 앱에 종료를 요청하고 프로세스가 사라질 때까지 기다린다. 사라졌으면 0 을 돌려준다.
quit_app() {
  osascript -e 'tell application "Iris" to quit' 2>/dev/null || true
  for _ in $(seq 1 10); do running || return 0; sleep 1; done
  ! running
}

echo "3/6  앱 종료"
# 사용자가 종료를 취소했거나 앱이 응답하지 않으면 여기서 멈춘다. 떠 있는 앱의 번들을 옮기면
# 그 앱은 사라진 파일을 읽게 되고, 새 앱을 열면 두 앱이 함께 뜬다.
if ! quit_app; then
  echo "앱이 종료되지 않아 교체하지 않습니다. 앱을 종료한 뒤 다시 실행하세요."
  exit 1
fi

# 교체는 되돌릴 수 있어야 한다. ditto가 중간에 실패하면 /Applications에 반쪽 앱만 남아 아무것도
# 못 켠다. 그래서 옛 것을 옆으로 밀어두고, 새 앱과 그 서버가 준비된 것을 본 뒤에 지운다.
OLD=""
# 새 앱을 치우고 옛 앱을 제자리에 둔 뒤 다시 연다. 앱은 이미 종료했으므로 되돌린 뒤 열지 않으면
# 사용자는 앱이 없는 상태로 남는다.
rollback() {
  echo "$1 — 이전 앱으로 되돌립니다."
  if running && ! quit_app; then
    echo "새 앱이 종료되지 않아 되돌리지 못했습니다. 이전 앱은 ${OLD:-없음} 에 있습니다."
    exit 1
  fi
  rm -rf "$APP"
  if [ -n "$OLD" ]; then
    mv "$OLD" "$APP"
    installed_env open -a "$APP" || echo "이전 앱을 다시 열지 못했습니다 — $APP 를 직접 여세요."
  fi
  exit 1
}

echo "4/6  교체"
if [ -d "$APP" ]; then OLD="$APP.old-$$"; mv "$APP" "$OLD"; fi
ditto "$BUILT" "$APP" || rollback "교체 실패"

echo "5/6  실행"
installed_env open -a "$APP" || rollback "새 앱 실행 실패"
for _ in $(seq 1 10); do running && break; sleep 1; done
running || rollback "새 앱이 유지되지 않음"
installed_env node scripts/wait-installed-server.cjs || rollback "새 앱의 서버가 준비되지 않음"
running || rollback "새 앱이 서버 준비 중에 종료됨"

echo "6/6  에이전트 컨텍스트 안내 설치"
# 앱은 이미 바뀌어 돌고 있다. 스킬 파일 하나 때문에 여기서 실패하면 옛 앱 사본이 남고 설치가
# 실패로 끝난다. 안내만 남기고 마친다. ./setup --check 가 이 상태를 다시 보여 준다.
node scripts/install-agent-context.mjs --app "$APP" || echo "에이전트 스킬 파일을 놓지 못했습니다 — 위 이유를 해결한 뒤 ./setup 을 다시 돌리면 됩니다."
[ -n "$OLD" ] && rm -rf "$OLD"
echo "교체 완료 — 설치된 앱이 현재 소스로 돕니다."
