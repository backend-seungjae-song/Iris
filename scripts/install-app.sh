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

echo "3/6  앱 종료"
osascript -e 'tell application "Iris" to quit' 2>/dev/null || true
for _ in $(seq 1 10); do pgrep -f "$APP/Contents/MacOS/Iris" >/dev/null || break; sleep 1; done

# 교체는 되돌릴 수 있어야 한다. ditto가 중간에 실패하면 /Applications에 반쪽 앱만 남아 아무것도
# 못 켠다. 그래서 옛 것을 옆으로 밀어두고, 새 것이 다 들어간 뒤에 지운다.
echo "4/6  교체"
OLD=""
if [ -d "$APP" ]; then OLD="$APP.old-$$"; mv "$APP" "$OLD"; fi
if ! ditto "$BUILT" "$APP"; then
  echo "교체 실패 — 옛 앱으로 되돌린다"
  rm -rf "$APP"
  [ -n "$OLD" ] && mv "$OLD" "$APP"
  exit 1
fi
echo "5/6  실행"
# 이 스크립트는 pnpm 안에서 돌고, `open`은 지금 셸의 환경을 앱에 그대로 물려준다. 그래서
# 개발용으로 띄웠던 셸에서 실행하면 설치된 앱이 개발 설정을 안고 뜬다. 흘러든 REMOTE=1 로
# 설치된 앱이 127.0.0.1 이 아니라 0.0.0.0 에 붙은 적이 있다. 설치된 앱은 개발 환경 변수를
# 물려받지 않는다.
if ! env -u IRIS_PORT -u IRIS_STATE_DIR -u PORT -u REMOTE -u HOST open -a "$APP"; then
  echo "새 앱 실행 실패 — 이전 앱으로 되돌립니다."
  if [ -n "$OLD" ]; then
    rm -rf "$APP"
    mv "$OLD" "$APP"
    env -u IRIS_PORT -u IRIS_STATE_DIR -u PORT -u REMOTE -u HOST open -a "$APP" || true
  fi
  exit 1
fi
for _ in $(seq 1 10); do pgrep -f "$APP/Contents/MacOS/Iris" >/dev/null && break; sleep 1; done
if ! pgrep -f "$APP/Contents/MacOS/Iris" >/dev/null; then
  echo "새 앱이 유지되지 않아 이전 앱으로 되돌립니다."
  if [ -n "$OLD" ]; then
    rm -rf "$APP"
    mv "$OLD" "$APP"
    env -u IRIS_PORT -u IRIS_STATE_DIR -u PORT -u REMOTE -u HOST open -a "$APP" || true
  fi
  exit 1
fi
echo "6/6  에이전트 컨텍스트 안내 설치"
# 앱은 이미 바뀌어 돌고 있다. 스킬 파일 하나 때문에 여기서 실패하면 옛 앱 사본이 남고 설치가
# 실패로 끝난다. 안내만 남기고 마친다. ./setup --check 가 이 상태를 다시 보여 준다.
node scripts/install-agent-context.mjs --app "$APP" || echo "에이전트 스킬 파일을 놓지 못했습니다 — 위 이유를 해결한 뒤 ./setup 을 다시 돌리면 됩니다."
[ -n "$OLD" ] && rm -rf "$OLD"
echo "교체 완료 — 설치된 앱이 현재 소스로 돕니다."
