# 기능 관리·추가·공유 절차

Iris 소스를 처음 받은 사용자를 위한 기능 관리·추가·공유 절차다. 기능 경계의 설계 이유와
검사별 적용 범위는 `docs/capabilities.md`를 참고한다.

## 1. 기능 비활성화 절차

앱 왼쪽 rail 맨 아래의 「설정」을 누르고 왼쪽 분류에서 「편의 기능」을 선택한다.
목록에는 rail 화면이 있는 기능과 없는 기능이 함께 표시된다. 오른쪽 스위치를 누르면 즉시 저장된다.

목록 위의 「전부 · 최소 · 개발자」는 기능 그룹을 한 번에 적용하는 프리셋이다.
잠긴 항목은 프리셋을 적용해도 변경되지 않는다.

### 저장 위치

설정은 상태 폴더의 `features.json`에 저장한다. 상태 폴더는 `server/state-home.cjs`가 정한다.

- 설치 앱: `~/.iris/features.json`
- `IRIS_STATE_DIR`를 지정한 실행: 지정 폴더 아래. 개발 스크립트는 `$HOME/.iris-dev`를 쓴다.

```json
{"version":1,"revision":3,"hidden":["memolab","viewer"]}
```

`hidden`은 꺼진 기능 id 목록이다. 서버는 임시 파일에 쓴 뒤 이름을 변경하므로 불완전한 파일이
남지 않는다. 수동으로 수정할 때는 해당 상태 폴더를 사용하는 앱을 먼저 종료한다.

### 반영 시점

- 렌더러만 있는 기능: 켜면 설정 화면에서 즉시 로드한다. 이미 로드한 모듈은 해제할 수 없으므로,
  끈 뒤에는 ⌘⇧R(보기 → 강제 새로고침)로 다시 로드해야 제외된다.
- 서버·네이티브 구성 요소가 있는 기능: 켜기와 끄기 모두 앱 재시작 후 반영한다.
  켜면 상태는 즉시 저장되지만 현재 실행에서는 rail 버튼을 표시하거나 모듈을 로드하지 않는다.
  화면에는 「저장했습니다. 앱을
  다시 시작하면 켜집니다」를 표시한다. 렌더러만 먼저 로드하면 구성이 불완전하기 때문이다.
  재시작 여부는 표의 `server`·`native`로 정한다
  (`web/js/core/features.js`의 `featureNeedsRestart`).
- 메모: 서버 구성 요소가 항상 활성화되어 있어 재시작 대상이 아니다. 본 창에서 끈 뒤 ⌘⇧R을
  실행하면 본 창에서 제외된다.
- 프리셋: 상태를 저장한 뒤 현재 로드할 수 있는 기능만 로드하고, 나머지는 기능 이름으로 안내한다.

앱 재시작으로 서버 설정까지 반영하려면 앱이 서버를 자식 프로세스로 실행해야 한다.
별도로 실행한 서버가 있으면 앱은 연결만 하며 종료 시 그 서버를 종료하지 않는다
(`native/electron/server-host.cjs`). 이 경우 서버·네이티브 구성의 변경을 반영하려면 별도 서버도
재시작한다. §4 「격리 실행 절차」를 참고한다.

### 비활성화 시 로드 범위

- 렌더러: 등록표의 `load()` 동적 import를 호출하지 않는다. 해당 기능의 화면·영역·WS 처리기를
  등록하지 않는다.
- 서버: 부팅 시 꺼진 행의 `init`·`onConnect`·`handle`을 조립에서 제외한다. 해당 HTTP 경로는
  예약한 뒤 404로 응답한다. 정적 파일 서빙으로 처리되는 것을 막기 위해서다.
- 네이티브: 해당 모듈을 `require`하지 않으며 해당 기능의 IPC도 등록하지 않는다.

### 예외

- 메모: 메모 창과 스페이스 키 이관이 함께 사용하므로 서버 구성 요소는 항상 활성화한다
  (`serverAlways`). 본 창에서 끄면 본 창의 화면과 영역만 제외하고 메모 창에서는 계속 로드한다.
- 잠긴 항목: 작업과 설정은 끌 수 없다. 작업은 rail 탐색 경로를 유지하고, 설정은 기능을 다시
  켤 수 있는 경로를 제공한다.
- 원격 창: 로컬(127.0.0.1) 연결이 아니면 저장을 거절하고 목록을 읽기 전용으로 표시한다.
- 상태 읽기 실패: 꺼진 기능을 알 수 없으므로 선택 기능을 로드하지 않고 앱을 실행한다.
  설정 변경을 잠그고 화면에 이유를 표시한다.

## 2. 기능 추가 절차

rail 화면 유무에 따라 등록 절차가 다르다. rail 화면이 있는 기능은 영역·마크업·화면 폭을
모두 정의해야 한다. rail 화면이 없는 기능은 `screen`을 반환하지 않는다.
`web/js/core/capability-boot.js`는 rail이 없는 기능이 `screen`을 반환하면 접근 경로가 없는
화면으로 판정하여 해당 기능만 실패 처리한다.

### 2-1. rail 화면이 있는 기능 추가

다음 아홉 항목을 모두 완료해야 한다. 누락된 항목은 검사에서 실패한다.

예시: 아래 두 경로는 실제 파일이 아니다.

    web/js/hello/boot.js      기능의 입구
    web/css/33-hello.css      그 기능의 지면

1. 진입 파일을 만들고 파일 상단에 계약 헤더의 다섯 항목을 적는다. 검사는 등록표의 `load`가
   가리키는 파일의 첫 40줄에서 다섯 용어를 찾는다("기능 파일은 자기 머리말을 갖는다").
   주석으로 작성하며, 항목 뒤의 설명은 자유롭게 쓸 수 있다.

   ```js
   // 소유 범위: 인사 화면과 그 자리의 안쪽 마크업.
   // 제공 API: initCapability · panelHtml.
   // 의존 대상: ctx 의 $ · wsSend.
   // 유지 조건: 슬롯 내부 마크업은 이 파일이 만든다. index.html 에 두지 않는다.
   // 영향 범위: 등록표와 rail 표의 hello 줄 · web/css/33-hello.css.

   export const panelHtml = `
     <div class="panel-head"><span>인사</span></div>
     <div class="hello-body"></div>`;

   export function initCapability(ctx) {
     return { screen: { enter() {}, leave() {} }, ws: { "hello.state": (m) => {} } };
   }
   ```

   `panelHtml`은 영역 내부의 마크업만 포함한다. 외부 요소(`<aside>`와 id·class)는
   `web/js/devtool/rail.js`의 `registerPanel`이 rail 표를 읽어 만든다. 내부 마크업을 다른
   파일에서 정의해도 진입 파일에서 다시 `export`해야 한다. 검사는 진입 파일만 확인하며,
   해당 export가 없으면 영역이 생성되지 않는다. 태그 짝이 맞지 않아도 검사에서 실패한다.

2. `web/js/core/rail-items.js`에 한 행을 등록한다. `panel`은 화면 영역의 element id다.

   ```js
   { id: "hello", label: "인사", title: "인사말",
     icon: "<circle cx=\"12\" cy=\"12\" r=\"9\"/>",
     body: "hello-active", panel: "hello-panel", layout: "panel",
     canDisable: true, disabledReason: "" },
   ```

   `body`는 화면이 활성화될 때 `document.body`에 추가하는 class다(`web/js/devtool/rail.js`).
   `panel`과 `body`는 새 기능에서 직접 정한다. `panel`만 지정하고 `body`를 비우면 검사에서
   실패한다("표의 각 줄이 실물과 이어져 있다"). `layout`은 파일 섹션을 유지하는 `panel`과
   파일 섹션까지 덮는 `full` 중 하나다. `icon`에는 svg 내부 마크업만 넣는다.

   화면 영역은 `web/index.html`에 작성하지 않는다. rail 로드 시 `registerPanel`이
   `id="hello-panel" class="rail-panel hello-panel"` 요소를 만들고 `panelHtml`을 채운다.
   같은 id가 index.html에도 있으면 중복으로 판정하여 실패한다.
   등록표(2-2)의 `panel`은 앱 셸이 이미 정의한 영역을 참조하므로 해당 id가 index.html에 있어야 한다.

3. `web/js/core/capabilities.js`에 한 행을 등록한다. rail id는 `rail`에 적고 이 표의
   `panel`은 비워 둔다(2-2 참고).

   ```js
   { id: "hello", rail: "hello", files: ["hello/boot.js"], css: ["33-hello.css"],
     load: () => import("../hello/boot.js") },
   ```

4. `web/index.html`의 rail 버튼 마크업을 교체한다. 표가 기준이며 마크업은 생성 결과와
   문자열까지 같아야 한다. 생성기는 `web/js/devtool/rail.js`의
   `railButtonsMarkup(items, activeId)`다. 두 번째 인자는 초기 활성 화면 id다.
   검사가 `"workspace"`를 넣은 출력과 대조하므로 같은 값으로 생성한다.
   `active`는 해당 행 하나에만 적용한다.

   ```sh
   node --input-type=module -e '
   import { RAIL_ITEMS } from "./web/js/core/rail-items.js";
   import { railButtonsMarkup } from "./web/js/devtool/rail.js";
   console.log(railButtonsMarkup(RAIL_ITEMS, "workspace"));
   '
   ```

   출력을 `web/index.html`의 rail 버튼 영역에 모두 넣는다. 검사는 공백을 한 칸으로 정규화하므로
   들여쓰기와 줄바꿈은 달라도 된다. 문자·순서·속성이 다르면 불일치 위치를 알리고 실패한다.
   초기 활성 화면(`active`)은 정확히 하나여야 한다.

5. CSS 파일을 만든다. 번호는 `web/css/`의 마지막 번호 다음을 쓴다. 마지막 파일이
   `32-sketch.css`이면 새 파일은 `33-hello.css`이며, `web/index.html`의 `<link>`도 번호순으로
   끝에 추가한다. 표의 `css`에 적은 파일이 index.html에 연결되지 않으면 검사에서 실패한다.
   조상 선택자 없이 정의하는 class 이름은 해당 기능만 사용해야 한다.

   화면 영역의 폭도 이 CSS 파일에 정의한다. rail 표에 `panel`이 있는 행은 기능 CSS에
   `.hello-panel { width: … }`가 있어야 한다. 영역 계약 파일 `web/css/03-feature-modes.css`에
   폭을 정의하면 검사에서 실패한다.

6. 서버 구성 요소가 있으면 `server/capabilities.js`에 같은 id로 등록하고 렌더러 표의
   `server`에 파일 경로를 적는다. 네이티브 구성 요소가 있으면
   `native/electron/capabilities.cjs`에 등록하고 렌더러 표에 `native: true`를 적는다.

7. 화면 카탈로그와 점검표를 수정한다. `docs/iris-screens.json`에 `kind: "rail"` 행을 추가하고
   `entry`는 rail id와 같은 값을 쓴다. `docs/iris-sequential-audit.md`에는 `## <entry>` 절을
   추가한다. 점검표의 절 순서는 카탈로그와 같아야 하며 항목 번호는 `hello-01`처럼 화면 이름에 붙인다.

8. 새 파일을 Git 목록에 등록한다. 등록하지 않으면 검사와 공유 도구가 파일을 인식하지 못한다.

   ```sh
   git add -N <새로 만든 파일들>
   ```

9. 검사를 실행한다.

   ```sh
   node scripts/run-tests.mjs --fast
   node bin/graph.mjs --check
   ```

### 2-2. rail 화면이 없는 기능 추가

rail 표에 등록하지 않고 `screen`과 `panelHtml`도 반환하지 않는다. 둘 중 하나라도 반환하면
해당 기능만 실패 처리한다.

```js
export function initCapability(ctx) {
  return { ws: { "hello.state": (m) => {} } };   // screen 없음
}
```

등록표에는 `rail` 대신 `label`을 적는다. rail 표에서 이름을 가져올 수 없으므로 설정 목록에
표시할 이름을 직접 제공해야 한다.

```js
{ id: "hello", label: "인사", files: ["hello/boot.js"], css: ["33-hello.css"],
  load: () => import("../hello/boot.js") },
```

이 표의 `panel`은 rail 표의 `panel`과 다르다. 앱 셸이 `web/index.html`에 이미 정의한
도크·상태 표시줄 영역의 element id를 가리킨다. 메모 도크·실행 도크·창 아래 상태 표시줄 등이
해당한다. 기능을 끄면 `web/js/devtool/rail.js`가 이 영역을 숨긴다.
따라서 해당 id가 index.html에 없으면 검사에서 실패한다.

기능이 새 화면 영역을 생성하는 경우는 rail 표의 `panel`을 쓴다. 이 영역은 `panelHtml`로
제공하므로 index.html에도 작성하면 중복으로 실패한다. 등록표의 `panel`은 앱 셸이 정의한
영역을 기능과 함께 숨겨야 할 때만 지정한다.

CSS·서버·네이티브·`git add -N`·검사는 2-1의 5·6·8·9와 같다.
rail 화면이 없으므로 화면 카탈로그는 수정하지 않는다.

## 3. 구현 계약

### 렌더러 모듈

진입 모듈은 `initCapability(ctx)`를 내보내고 `{ screen, ws }`를 반환한다.

- `screen`: rail 화면 진입·종료 시 호출할 동작이다. rail이 없는 기능이 반환하면 화면 접근
  경로가 없으므로 해당 기능만 실패 처리한다.
- `ws`: 서버 메시지 type과 처리기의 대응표다. 다른 기능이 같은 type을 등록했으면 거절한다.
- `panelHtml`: rail 화면의 내부 마크업을 내보내는 이름이다. 동작 연결 전에 삽입한다.
  rail이 없는 기능이 제공하면 열 수 없는 영역이므로 해당 기능만 실패 처리한다.

`ctx`는 `web/js/main.js`의 `capabilityBootArgs`가 제공하는 앱 셸의 공용 값과 함수다
($ · esc · wsSend · showToast · 창 모드 등). 제공되지 않는 이름을 사용하면 해당 기능이
실패할 수 있으므로, 검사가 사용하는 이름과 제공하는 이름을 대조한다.

### 렌더러 등록표 구성

| 칸 | 뜻 |
| --- | --- |
| `id` | 세 표를 연결하는 키. 소문자로 시작하는 짧은 이름 |
| `windows` | 기능을 로드할 창(`main`·`browser`·`memo`). 생략하면 본 창에서만 로드 |
| `alwaysIn` | 사용자가 꺼도 해당 창에서는 로드 |
| `files` | 기능이 전용으로 사용하는 모든 렌더러 파일 |
| `css` | 기능의 CSS 파일 |
| `server` | 서버·네이티브의 기능 전용 파일 |
| `native` | 네이티브 구성 요소 유무 |
| `page` | 기능이 소유하는 독립 화면 디렉터리 |
| `routes` | 독립 화면이 사용하는 HTTP 경로 |
| `rail` | 연결할 rail 화면 id |
| `panel` | 앱 셸이 index.html에 정의한 도크·상태 표시줄 영역의 element id. 끄면 함께 숨긴다. rail 화면 영역은 rail 표에 적는다 |
| `label` | rail이 없는 기능의 표시 이름 |
| `presets` | 포함할 프리셋 그룹 |
| `load` | 동적 import만 허용. 꺼진 기능을 로드하지 않는 조건 |

`server`나 `native`를 지정한 기능은 재시작 대상이다. 설정에서 켜면 상태는 저장하지만 현재
실행에서는 rail 버튼을 표시하거나 모듈을 로드하지 않는다. 「저장했습니다. 앱을 다시 시작하면 켜집니다」를
표시한다(`web/js/core/features.js`의 `featureNeedsRestart`·`pendingRestart`).
`alwaysIn: ["memo"]`인 기능은 서버 구성 요소가 항상 활성화되어 있으므로 예외다.

### 서버 등록표 구성

```js
{
  id: "archive", wsPrefixes: ["archive."],
  init(ctx) { initArchiveHandlers(ctx); },
  handle(ws, msg) { if (!msg.type.startsWith("archive.")) return false; handleArchive(ws, msg); return true; },
}
```

- `wsPrefixes`: 수신 메시지 접두사다. 공유 도구가 충돌 판정에 사용한다.
- `init(ctx)`: 부팅 시 한 번 호출한다. `handle`은 해당 기능의 메시지를 처리하면 참을,
  다른 메시지이면 거짓을 반환한다.
- `onConnect(ws)`: 새 연결에 보낼 초기 메시지를 정의한다.
- `http`: `{ method, path, handler }` 목록이다. `prefix: true`이면 하위 경로 전체를 소유한다.
- `serverAlways: true`: 사용자가 꺼도 서버 구성 요소를 조립한다(메모).

`ctx`는 `broadcast` · `broadcastLocal` · `visitClients(fn)` · `onShutdown(fn)` ·
`onExit(fn)`을 제공하며, `herdr`는 두 번째 조립 직전에 설정한다. 실행 기능처럼 자체 관리자를
사용하면 `init`에서 `ctx.runManager`에 저장하고 해당 기능의 HTTP 처리기에서 참조한다.

### 네이티브 등록표 구성

```js
{ id: "sketch", module: require.resolve("./sketch-shot.cjs") },
```

모듈은 `require.resolve`로 지정한다. 모듈을 실행하지 않아 표를 읽어도 로드되지 않으며,
그래프 도구는 참조 간선을 인식할 수 있다. 대상 모듈은 `initCapability(ctx)`를 내보내야 한다.
`ctx`는 `native/electron/main.cjs`가 제공하는 앱 셸의 공용 값과 API다
(BrowserWindow · ipcMain · preload 경로 · 상태 폴더 등).
등록된 모듈을 `main.cjs` 최상위에서 `require`하면 이 로드 경계가 유지되지 않는다.

### 앱 셸에서 기능을 호출하는 방법

훅 이름으로 호출한다. 로드되지 않은 기능의 훅은 오류 없이 아무 동작도 하지 않는다.

```js
// 틀 쪽
import { callHook } from "../core/hooks.js";
callHook("memo.archive");
// 기능 쪽
import { provide } from "../core/hooks.js";
provide("memo.archive", () => archiveMemo());
```

## 4. 의존성 설치와 실행·검증

### 사전 준비

1. Node 버전을 확인한다. 요구 범위는 `package.json`의 `engines`이며 22 이상이다.

   ```sh
   node -v
   ```

2. pnpm을 준비한다. 이 저장소는 `pnpm-lock.yaml`을 사용하므로 npm·yarn으로 설치하지 않는다.

   ```sh
   corepack enable pnpm   # 또는: npm i -g pnpm
   ```

3. 의존성을 설치한다. `prepare`가 함께 실행되어 `web/vendor/`를 생성한다.

   ```sh
   pnpm install
   ```

사전 준비를 마친 뒤 다음 실행·검사를 진행한다.

### 격리 실행 절차

개발 환경과 설치 앱은 포트와 상태 폴더를 분리한다. 같은 상태 폴더를 쓰면 서버 둘이 서로의
상태를 덮어쓸 수 있다.

서버 프로세스는 앱이 관리한다. 앱 시작 시 자식 프로세스로 실행하고 앱 종료 시 함께 종료한다.
서버·네이티브 구성 요소가 있는 기능은 다음 명령으로 앱만 실행한다.
이 방식이어야 §1의 앱 재시작으로 서버 변경 사항까지 반영할 수 있다.

```sh
IRIS_PORT=4293 IRIS_STATE_DIR=$HOME/.iris-lab pnpm exec electron native/electron/main.cjs
```

서버만 수정하거나 화면 없이 검사할 때는 서버만 실행할 수 있다.

```sh
IRIS_PORT=4293 IRIS_STATE_DIR=$HOME/.iris-lab HOST=127.0.0.1 node server/index.js
```

별도로 실행한 서버가 있으면 앱은 연결만 하며 해당 서버를 관리하지 않는다
(`native/electron/server-host.cjs`의 `owned`). 앱을 재시작해도 서버는 계속 실행된다.
기능의 서버·네이티브 구성과 코드 변경을 반영하려면 해당 서버도 재시작한다.

개발 스크립트도 서버와 앱을 별도로 실행하므로 같은 조건이 적용된다.
포트는 4291, 상태 폴더는 `$HOME/.iris-dev`로 고정한다.

```sh
pnpm dev        # 서버만. PORT·IRIS_PORT=4291, IRIS_STATE_DIR=$HOME/.iris-dev, node --watch
pnpm dev:app    # 앱. 같은 포트·같은 상태 폴더로 electron
```

- `IRIS_PORT`: 서버 포트다(기본 4271, `server/env.cjs`). 서버는 이전 이름인 `PORT`도
  허용하지만 `IRIS_PORT`를 우선한다.
- `IRIS_STATE_DIR`: 상태 폴더다(`server/state-home.cjs`). 맨 앞의 `~`·`$HOME`를 확장한 결과가
  절대경로여야 한다. 아니면 빈 폴더를 만들지 않고 서버를 중단한다. 생략하면 `~/.iris`를 쓴다.
- `HOST`: 바인딩 주소다. 기본값은 `127.0.0.1`이다.

한 상태 폴더는 서버 하나만 사용한다. 해당 폴더의 `server.lock`을 획득한 서버만 실행한다.

### 검증

기본 검사 명령은 다음 두 개다. 공유 패키지의 README도 같은 명령을 안내한다.

```sh
node scripts/run-tests.mjs --fast   # smoke + 기능 그래프 + test/ 의 오프라인 검사(느린 셋 제외)
node bin/graph.mjs --check          # 고아 파일·죽은 export·문서가 대는 없는 경로
```

구조·계약 검사는 `node bin/smoke.mjs`로 별도 실행한다. 기능 하나를 검사할 때는 해당 파일만 실행한다.

```sh
node --test test/feature-renderer.mjs
```

검사 통과가 전체 검증을 의미하지는 않는다. 검사 범위 밖의 동작이나 실행할 수 없었던 검사는
미검증으로 구분한다.

- `bin/smoke/sections/qa-contracts.mjs`는 `$HOME/.claude/.claude-system`이 없으면 21건을
  「못 잼(skipped: 홈 도구 없음)」으로 건너뛴다. 전체 검사가 통과해도 해당 계약은 검증되지 않는다.
- 실제 실행 검사도 포함한다. `test/feature-server.mjs`는 여러 hidden 조합으로 서버를 실행하고,
  `test/feature-native.mjs`는 실제 네이티브 host에서 등록표를 부팅한다.
  `bin/smoke/sections/browser-file-drop.mjs`는 임시 프로필의 headless Chrome/Chromium에
  실제 드롭 이벤트를 보낸다. 실행 파일이 없으면 실패하며 `CHROME_BIN`으로 지정할 수 있다.
  실제 렌더러의 기능 표시와 재시작 후 서버·네이티브 동작은 앱에서 사용자 경로로 직접 확인해야 한다.
- `scripts/run-tests.mjs`는 smoke 성공 시 출력을 버리므로 「못 잼」 항목을 표시하지 않는다.
  미측정 항목은 `node bin/smoke.mjs`를 직접 실행하여 확인한다.

## 5. 공유 패키지 구성

기능 공유 패키지는 공유 도구로 생성한다.

```sh
node bin/capability-share.mjs manifest --id hello --base <기준 커밋> [--out <디렉터리>]
```

기준 커밋은 현재 HEAD의 조상이어야 한다. 그 이후의 모든 변경이 패치에 포함되므로 기능과
무관한 작업을 먼저 분리한 뒤 base를 정한다. 새 파일은 `git add -N`으로 목록에 등록해야 인식한다.

산출물은 다음 세 개다.

    manifest.json   base 커밋·Iris 버전·Node 버전·바뀐 의존성·파일 목록과 sha256·
                    이름 선언(rail id·css 파일·WS 접두사·HTTP 경로)·설정 키 후보
    <id>.patch      그 변경 전부
    README.md       받는 쪽 절차. `<보내는 쪽: …>` 은 보내기 전에 채우고,
                    `<받는 쪽: …>` 은 받는 사람이 자기 값으로 바꾼다

다음 항목은 패키지에서 제외한다.

- 작성자의 절대 경로: 패치에 `/Users/…` 같은 경로가 있으면 생성을 거절한다.
  코드에서 경로를 제거한 뒤 다시 생성한다.
- 사용자별 설정·비밀: `settingsKeys`는 변경된 소유 파일에서 찾은 `localStorage`·
  `sessionStorage` 키와 `process.env` 이름의 후보 목록이다. 계산한 키와 간접 호출은 찾지
  못하므로 코드를 직접 확인한다. 값은 코드에서 제외하고 README에 설정 방법을 적는다.
- 로컬 상태: 상태 폴더는 저장소 밖이므로 패치에 포함되지 않는다. 기능이 해당 폴더에 파일을
  생성한다면 경로와 초깃값을 README에 적는다.

보내기 전에 명시 파일 목록을 직접 확인한다.

```sh
node -e 'for (const f of JSON.parse(require("fs").readFileSync(process.argv[1])).files) console.log(f.status, f.path)' <디렉터리>/manifest.json
```

## 6. 수신한 기능의 적용·설정·실행 절차

`bin/capability-share.mjs manifest`는 패키지의 `README.md`에 기준 커밋·Iris·Node 버전,
새 의존성, 설정 키 후보와 다음 절차를 작성한다. 명령에는 해당 패키지의 id·파일 목록을 사용한다.
`<보내는 쪽: …>`은 작성자가 제공할 설명이고, `<받는 쪽: …>`은 수신자가 패키지 경로·포트·
상태 폴더 등 자신의 값으로 바꿀 항목이다.

1. 기능 설명과 필요한 설정을 읽는다. README의 「지원 대상」에는 `settingsKeys`가,
   「무엇인가」에는 화면 위치와 사용하는 외부 서비스가 적힌다. 키 목록은 변경된 소유 파일의
   `localStorage`·`sessionStorage`·`process.env` 이름 후보이며 계산한 키와 간접 호출은
   포함하지 않으므로 코드도 확인한다.

2. 패키지를 검사하고 적용한다.

   ```sh
   node bin/capability-share.mjs check <디렉터리>   # 적용하지 않는다
   git apply <디렉터리>/<id>.patch
   git add -N .
   pnpm install                                     # 새 의존성이 있을 때만
   node scripts/run-tests.mjs --fast
   ```

   `check`는 작업 트리를 수정하지 않고 적용 결과를 비교한다. 기준 커밋이 저장소 이력에 없어도
   거절하지 않고 안내만 한다. 같은 내용을 다른 sha로 가진 사본일 수 있기 때문이다.
   패치의 hunk를 수신자의 작업 트리 본문에 적용한 결과를 계산하고, sha256이 작성자 파일과
   같은지 확인한다. hunk 밖의 차이로 결과가 달라지는 경우도 검출한다.
   마지막에 `git apply --check`를 실행한다. 통과는 작성자와 같은 코드가 적용된다는 의미이며,
   해당 환경에서 기능이 동작한다는 보장은 아니다.

3. 설정값을 입력한다. `settingsKeys`의 값은 코드에 포함되지 않는다. README에 안내된 설정
   화면이나 환경변수에 직접 입력한다. 기능이 상태 폴더에 파일을 생성하면 해당 경로와 초깃값도
   README에서 확인한다.

4. 개발 사본을 전용 상태 폴더와 포트로 실행한다(§4의 격리 실행 절차).
   앱이 서버를 자식 프로세스로 실행하므로 다음 명령 하나를 사용한다. README도 같은 명령을 안내한다.

   ```sh
   IRIS_PORT=4293 IRIS_STATE_DIR=$HOME/.iris-lab pnpm exec electron native/electron/main.cjs
   ```

   서버만 있는 기능은 `IRIS_PORT=… IRIS_STATE_DIR=… node server/index.js`로 확인할 수 있다.
   별도 서버는 앱 재시작으로 종료되지 않으므로 변경 사항을 반영할 때 함께 재시작한다.

5. 기능을 확인한다. rail 화면이 있으면 왼쪽 rail의 버튼을 눌러 화면이 표시되는지 확인한다.
   rail 화면이 없으면 설정 → 편의 기능 목록에 이름이 표시되는지 확인한다.
   정상 상태의 구체적인 기준은 작성자가 README의 「실행과 확인」에 적는다.

6. 기능을 끄고 필요하면 코드를 되돌린다. 설정 → 편의 기능에서 끄면 `features.json`에 저장된다.
   렌더러 전용 기능은 ⌘⇧R로 다시 로드하면 제외되고, 서버·네이티브 구성 요소가 있는 기능은
   앱을 재시작해야 제외된다. 코드를 제거하려면 다음 명령으로 패치를 되돌린다.

   ```sh
   git apply --reverse <디렉터리>/<id>.patch
   ```

## 7. 버전·의존성 문제 해결

`check`의 알림별 확인 항목은 다음과 같다.

| 알림 | 확인 항목 |
| --- | --- |
| 기준 커밋이 이 저장소 이력에 없다 | 안내 항목이다. 같은 내용을 다른 sha로 가진 사본일 수 있다. 적용 가능 여부는 같은 실행의 `git apply --check`가 판정한다 |
| Iris 버전 불일치 | 두 저장소의 `package.json` `version`이 같아야 한다 |
| Node 주 버전 불일치 | `node -v`와 `package.json`의 `engines` 확인 |
| 의존성 충돌 | 같은 의존성의 버전이 다르다. 사용할 버전을 정한 뒤 적용한다 |
| 새 의존성 | 안내 항목이다. 적용 후 `pnpm install` 실행 |
| id·rail·css·WS 접두사·HTTP 경로 충돌 | 기존 기능이 해당 이름을 사용한다. 작성자에게 이름 변경을 요청한다 |
| 패치 sha256 불일치, 선언 누락 | 생성 후 패키지가 수정되었다. 다시 받는다 |
| 파일 sha256 불일치 | hunk 밖의 변경 때문에 작업 트리에 적용한 결과가 작성자 파일과 다르다 |
| `git apply --check` 실패 | base 이후 해당 파일이 변경되었다. 변경 이력을 확인한다 |

`check`는 기준 커밋·Node 주 버전·Iris 버전·등록표의 리터럴 선언을 확인한다.
패치의 hunk를 수신자의 작업 트리 본문에 적용한 결과를 계산하여 작성자 파일의 sha256과
대조한 뒤 `git apply --check`를 실행한다. 작업 트리를 수정하지 않으며,
통과는 작성자와 같은 코드가 적용된다는 의미다.

UTF-8 텍스트 패치만 지원한다. 바이너리·심볼릭 링크·인용된 경로는 지원하지 않는다.
실제 기능 동작과 사용자별 설정은 적용 후 별도로 확인한다.
