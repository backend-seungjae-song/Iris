# Iris 폰 원격 프로토콜

이 문서는 등록된 폰이 Iris 서버의 `remote/1` WebSocket에 인증한 뒤 쓰는 요청 계약이다. JSON 객체의 키는 각 표에 적힌 키만 허용한다. 선택 필드가 아닌 키가 빠지거나 모르는 키가 있으면 `invalid-request`다.

## 1. 공통 형식

- `rid`: `[A-Za-z0-9_-]` 1–32자. 요청과 직접 응답을 연결한다.
- `ref`: 소문자 32자리 hex. 서버가 발급한 불투명 값이며 다시 연결하거나 서버가 재시작하면 새로 받는다.
- `agent`, `tab`, `space`, `file`, `request`: 해당 목록 응답에서 받은 `ref`만 보낸다.
- 문자열 길이는 JavaScript 문자열 길이 기준이다. 제어 문자는 줄바꿈을 허용한다고 적힌 필드에서만 허용한다.
- 서버는 Mac 절대 경로, 세션 UUID, pane ID, 브라우저 내부 탭 ID를 보내지 않는다. 탭·파일·에이전트는 `ref`로 가리킨다.
- 폰에서 서버로 보내는 WebSocket 프레임과 일반 서버 응답은 64 KiB 이하다. `browser.frame`은 520 KiB, `browser.draft.result`는 400 KiB까지 받는다. 게이트웨이·IPC·폰은 JSON의 `type`을 확인한 뒤 이 두 응답에만 큰 상한을 적용한다. 인증 전에는 아래 기능 요청을 처리하지 않고 연결을 닫는다.

연결 직후 서버는 `auth.challenge`를 보낸다. 폰은 등록 기기 키로 서명한 `auth.response`를 보낸다. 첫 연결이나 PIN 기한이 지난 연결은 서버가 `{"type":"pin.required","v":"remote/1"}`를 보내고 폰은 아래 메시지로 접속 PIN을 제출한다.

등록 기기가 있는데 접속 PIN이 없거나 공유가 꺼져 있으면 서버는 같은 인증서와 Tailscale 주소에서 상태 안내 전용 연결을 받는다. 이 연결은 인증 전에 `{"type":"service.status","v":"remote/1","reason":"pin-required|sharing-disabled"}`만 보내고 닫는다. `pin-required`는 Mac의 Iris 원격 화면에서 접속 PIN을 정해야 한다는 뜻이고, `sharing-disabled`는 같은 화면에서 원격 제어를 켜야 한다는 뜻이다. 이 응답에는 PIN, 기기·서버 식별자, 등록 상태가 없다. 등록 기기가 없으면 상태 안내 전용 연결도 열지 않는다.

```json
{"type":"pin.submit","v":"remote/1","pin":"숫자 6–32자리"}
```

키는 `type`, `v`, `pin`만 허용한다. 서버는 PIN까지 맞아야 `auth.ok`를 보낸다. PIN 전에는 페어링과 위 인증 메시지 외의 요청을 처리하지 않으며 목록과 푸시도 보내지 않는다. 틀린 PIN에는 `{"type":"pin.error","v":"remote/1","reason":"incorrect|retry-later|unavailable","retryAfterMs":0}` 형식으로만 답한다. `retryAfterMs`는 0–60,000이며 연속 실패할수록 늘어난다. 재개 토큰이 틀리거나 만료돼도 이 실패 횟수와 대기 시각은 지우지 않는다. 이 응답에는 PIN, 해시, 기기나 서버 내부 식별자가 없다.

PIN 인증 성공 응답은 아래 형식이다.

```json
{"type":"auth.ok","v":"remote/1","resumeToken":"base64url 43자","pinIdleMinutes":30}
```

`resumeToken`은 서버가 만든 32바이트 임의 값이다. 서버는 토큰의 SHA-256 값, 기기, 마지막 사용 시각만 `stateHome()/remote/resume-tokens.json`(0600, 디렉터리 0700)에 저장하고 토큰 원문은 저장하지 않는다. 변경은 2초 뒤에 한 번 쓰고 서버가 종료될 때 바로 쓴다. 서버가 다시 시작하면 마지막 사용부터 설정된 기한이 지나지 않은 항목만 읽는다. 폰은 마지막 토큰을 앱 저장소(SharedPreferences, `allowBackup=false`)에 두고, 앱을 다시 열면 PIN 없이 이 토큰으로 재접속을 먼저 시도한다. 재접속에는 기기 키 서명도 필요하므로 토큰만으로는 접속할 수 없다. 재접속이 실패하거나 사용자가 연결을 끊거나 등록을 해제하면 폰이 저장한 토큰을 지운다.

연결이 끊긴 폰은 새 `auth.challenge`에 등록 기기 키로 다시 서명하고 `auth.response`의 선택 필드 `resumeToken`을 함께 보낸다. 서버는 기기 서명, 서버 인스턴스, Tailscale 노드, 인증서 pin을 먼저 확인한다. 토큰의 기기가 서명 기기와 같고 마지막 사용부터 설정된 기한이 지나지 않았으면 PIN 없이 `auth.ok`와 새 토큰을 보낸다. 사용한 토큰은 즉시 폐기한다. 다른 기기의 토큰, 이미 쓴 토큰, 만료 토큰은 `pin.required`로 처리한다.

PIN 기한은 마지막 사용부터 10·20·30·60분이며 기본값은 10분이다. 화면만 보고 있는 시간이나 백그라운드 ping은 사용으로 세지 않는다. Mac의 Iris 원격 화면이 `remote.pin-idle.set`으로 바꾸며 `stateHome()/remote/session-policy.json`에 0600 권한으로 저장한다. 변경값은 연결된 세션과 보관 중인 재개 토큰에 바로 적용한다. 새 기한이 이미 지났으면 서버가 WebSocket을 코드 4001, 이유 `idle-timeout`으로 닫고 폰은 PIN 화면으로 돌아간다. 절대 1시간 제한은 없다.

폰이 전면에 있을 때 보내는 `{"type":"ping","rid":"...","active":true}`와 인증 후 유효한 기능 요청은 마지막 사용 시각을 갱신한다. 백그라운드 연결 확인용 `active:false` ping은 갱신하지 않는다. Android 전경 서비스는 연결 알림과 프로세스 우선순위를 유지하며 앱 복귀 시 폰이 즉시 소켓을 확인한다. 소켓이 끊겼으면 같은 화면 상태를 남긴 채 재개 토큰으로 연결하고 `watch`, 대화 기록, 터미널, 브라우저 화면을 다시 구독한다.

PIN 변경, 기기 등록 해제, 원격 공유 끄기, 원격 기능 숨김은 해당 재개 토큰을 즉시 폐기한다. 서버 재시작도 메모리 토큰을 모두 없앤다. 기기 등록 해제는 해당 기기만, 나머지는 모든 기기의 토큰을 폐기한다.

Mac 화면은 연결 순서의 PIN 단계 안에서 숫자 6–32자리와 확인 값을 `remote.pin.set`으로 로컬 Iris 서버에 보낸다. 설정 뒤에는 PIN 변경 폼과 `PIN 다시 확인` 기한 선택을 표시한다. 서버는 `stateHome()/remote/access-pin.json`에 임의 솔트와 scrypt 결과만 0600 권한으로 저장한다. 폰은 PIN과 재개 토큰을 디스크에 저장하지 않는다. PIN 변경은 현재 원격 연결과 재개 토큰을 모두 없앤다. 저장된 공유가 켜져 있으나 PIN이 없어 멈춘 상태라면 첫 PIN 저장 뒤 공유를 자동으로 다시 시작한다. 사용자가 켠 공유의 `enabled` 값은 Iris 종료와 다음 기동 뒤에도 유지하며 사용자가 끄거나 기능을 숨길 때만 저장값을 끈다.

`auth.ok`를 받은 폰은 `caps.get`을 보낸다.

```json
{"type":"caps.get"}
```

```json
{"type":"caps","remoteRpc":"remote/1","macName":"사용자가 Mac 설정에서 정한 컴퓨터 이름","requests":["caps.get","ping"]}
```

`caps.macName`은 사용자가 macOS 설정에서 정한 컴퓨터 이름이다. 제어 문자를 제거하고 64자로 제한한다. `caps.requests`에 있는 요청만 현재 Mac에서 쓸 수 있다. 터미널 연결, 브라우저 CDP 실행기, `git`, `gh` 상태에 따라 목록이 달라진다.

`watch`의 `agents[]` 항목은 아래 키를 모두 가진다. 이 객체도 모르는 키를 거부한다.

```json
{"ref":"Agent.ref","name":"표시 이름","kind":"claude|codex|other|terminal","status":"working|idle|done|blocked|unknown","question":false,"space":"스페이스 표시 이름","spaceRef":"Space.ref","spaceOrder":0,"sessionOrder":0,"parent":null,"lastActivityAt":null,"can":{"stop":true,"message":true}}
```

- `kind:terminal`은 에이전트 없는 herdr pane이다. `question:false`, `can.stop:false`, `can.message:false`이며 홈의 스페이스 아래 세션과 같은 순서로 표시한다. 상태 문구는 `터미널`이고 답 대기 목록에 넣지 않는다. 누르면 `terminal.watch` 화면을 연다. 해당 기능이 caps에 없으면 숨긴다.
- 이전 폰 파서는 모르는 kind를 무시하지 않고 agents 응답 전체를 거부한다. `terminal`을 지원하는 폰과 서버를 함께 갱신해야 한다.
- `spaceRef`는 같은 서버 실행 중 스페이스를 구분하는 불투명 ref다. 내부 workspace ID는 보내지 않는다.
- `spaceOrder`는 Iris 창에서 드래그해 저장한 스페이스 순서다. 저장 목록에 없는 현재 스페이스는 서버 스냅샷 순서로 뒤에 붙는다. `sessionOrder`는 그 스페이스의 탭 순서를 적용한 에이전트 순서다. 둘 다 0 이상의 정수다.
- Iris 창은 폴더 객체 키 목록을 `space-order.set`으로 보낸다. 서버는 인증된 로컬 UI 연결만 받고, 등록되지 않은 키를 버린 뒤 `stateHome()/space-order.json`에 저장한다. 순서가 바뀌면 `watch` 중인 폰에 새 `agents` 목록을 보낸다.
- `parent`는 같은 스페이스의 부모 `Agent.ref` 또는 `null`이다. 내부 pane ID는 보내지 않는다. 부모가 목록에 없으면 `null`이다.
- `lastActivityAt`은 Unix epoch 밀리초 또는 `null`이다. 폰의 최근 활동순은 이 값을 내림차순으로 정렬하며 `null`은 마지막에 둔다.

`transcript.page`의 `user`·`assistant` 글과 질문·허용 요청·사람 차례 본문은 GitHub Flavored Markdown으로 표시한다. 폰은 제목, 굵게·기울임, 중첩 목록, 인용, 표, 링크, 인라인 코드와 코드 블록을 지원한다. 코드 블록은 언어 이름에 따라 문법을 표시하고 줄을 접지 않으며 복사할 수 있다. `diff` 블록은 추가·삭제 줄을 구분한다. 링크와 이미지 대체 글자를 누르면 주소 확인과 복사를 제공한다. 대화의 확인창에는 caps에 `browser.tab.new`가 있을 때 `Mac 브라우저에서 열기`를 표시한다. 사용자가 이 버튼을 누를 때만 해당 에이전트 스페이스에 새 탭을 요청한다. 성공하면 응답의 `tab` ref와 해당 `agent` ref로 폰의 BrowserScreen을 연다. 실패하면 이동하지 않고 주소·파일·서버 오류에 맞는 사유를 표시한다. 새 탭 ref가 없는 이전 서버 응답에는 Mac 열기 성공만 안내한다. 사용자가 이 버튼을 누른 요청에만 화면을 이동하며 이미지도 네트워크에서 받지 않는다.

폰은 `transcript.page` 응답을 30초 동안 기다리며 그동안 대화 화면에 진행 표시를 둔다. 브라우저 화면과 조작은 CDP 명령 30초, 잠든 탭 준비 12초와 화면 변환 시간을 포함한 요청별 한도를 쓴다. 다른 요청은 기본 10초 한도를 쓴다.

## 2. 새 요청 표

| 요청 이름 | 용도 | 직접 응답 |
|---|---|---|
| `terminal.watch` | 에이전트 pane의 현재 화면과 변경 구독 | `terminal.watch.result`, 이후 `terminal.frame` |
| `terminal.input` | 글자와 Enter 입력 | `remote.action.result` |
| `terminal.key` | 키와 보조 키 입력 | `remote.action.result` |
| `terminal.select` | 최신 선택 목록 항목 실행 | `remote.action.result` |
| `terminal.mouse` | 최신 pane 셀의 SGR 마우스 입력 | `remote.action.result` |
| `terminal.scrollback` | pane의 최근 화면 기록 읽기 | `terminal.scrollback.result` |
| `terminal.keys.get` | 이 Mac의 폰 키 줄 읽기 | `terminal.keys` |
| `terminal.keys.set` | 이 Mac의 폰 키 줄 저장 | `terminal.keys` |
| `browser.tabs` | 모든 스페이스의 브라우저 탭 목록 | `browser.tabs.result` |
| `browser.frame.watch` | 탭 화면 JPEG 구독 | `browser.frame.watch.result`, 이후 `browser.frame` |
| `browser.pointer` | 한 번 또는 두 번 누르기 | `remote.action.result` |
| `browser.mouse` | 좌표 마우스 이동·누르기·휠·끌기 | `remote.action.result` |
| `browser.type` | 탭에 글자 입력 | `remote.action.result` |
| `browser.key` | 탭에 키 입력 | `remote.action.result` |
| `browser.scroll` | 세로 스크롤 | `remote.action.result` |
| `browser.history` | 뒤로·앞으로·새로고침 | `remote.action.result` |
| `browser.navigate` | 등록 기기에서 주소 이동 | `remote.action.result` |
| `browser.tab.new` | 새 탭 | `remote.action.result` |
| `browser.element` | 좌표의 요소 정보 | `browser.element.result` |
| `browser.element.hover` | 요소 선택 커서 아래 요소와 페이지 크기 | `browser.element.hover.result` |
| `browser.element.pick` | 요소를 데스크톱 선택 형식으로 입력칸에 추가 | `browser.draft.result` |
| `browser.element.send` | 좌표의 요소와 글을 대화 입력칸에 추가 | `browser.draft.result` |
| `browser.focus` | 현재 페이지 입력 초점과 선택 글자 확인 | `browser.focus.result` |
| `browser.dialog` | 페이지 대화상자 조회·응답 | `browser.dialog.result` |
| `browser.record.start` | 이 연결의 조작 기록 시작 | `browser.record.result` |
| `browser.record.pause` | 기록 일시 정지·재개 | `browser.record.result` |
| `browser.record.finish` | 기록을 대화 입력칸에 추가 | `browser.draft.result` |
| `browser.sketch.send` | 그림과 글을 대화 입력칸에 추가 | `browser.draft.result` |
| `browser.draft.remove` | 입력칸에서 붙여넣기 칩 삭제 | `remote.action.result` |
| `browser.profiles` | 브라우저 프로필 이름 목록 | `browser.profiles.result` |
| `browser.profile.set` | 탭의 프로필 전환 | `remote.action.result` |
| `browser.desktop` | 데스크톱 폭 전환 | `remote.action.result` |
| `browser.translate` | 현재 페이지를 선택한 언어로 번역 | `remote.action.result` |
| `browser.bookmarks` | 스페이스 북마크 목록 | `browser.bookmarks.result` |
| `browser.bookmark.set` | 현재 탭 북마크 추가·삭제 | `remote.action.result` |
| `browser.direct` | 현재 AI 조작 표시 해제 | `remote.action.result` |
| `git.changes` | 에이전트 작업 폴더의 변경 목록 | `git.changes.result` |
| `git.diff` | 한 파일의 diff | `git.diff.result` |
| `git.diff.draft` | diff 줄 의견을 입력창에 넣기 | `remote.action.result` |
| `github.pr` | 현재 브랜치 PR과 검사 상태 | `github.pr.result` |
| `github.check.log` | 선택한 실패 검사 로그 | `github.check.log.result` |
| `github.check.draft` | 실패 로그를 입력창에 넣기 | `remote.action.result` |
| `paseo.open` | 대화 화면 웹뷰 티켓 | `paseo.open.result` |
| `chat.open` | Paseo 대화 열기 | `chat.open.result` |
| `chat.older` | 이전 대화 요청 | `remote.action.result` |
| `chat.close` | 대화 닫기 | `remote.action.result` |

Git 요청은 읽기 전용이다. stage, commit, push 요청은 없다. `git.diff.draft`와 `github.check.draft`는 내용을 제출하지 않고 에이전트 입력창에 넣는다. 에이전트가 작업 중이면 `busy`다.

## 3. 터미널 요청

보조 키 객체는 항상 `{"ctrl":bool,"alt":bool,"shift":bool,"cmd":bool}` 네 키를 모두 가진다.

| 요청 | 필드와 한도 |
|---|---|
| `terminal.watch` | `{type,rid,agent}`. 연결당 한 에이전트이며 새 요청이 이전 구독을 바꾼다. |
| `terminal.input` | `{type,rid,agent,text}`. `text` 1–4,000자. CR, LF, 탭을 허용하며 다른 제어 문자는 금지한다. 서버는 CR·CRLF를 LF로 바꾸고 bracketed paste로 감싼 뒤 Enter를 한 번 붙여 같은 pane에 보낸다. |
| `terminal.key` | `{type,rid,agent,key,modifiers}`. `key` 1–24자, 줄바꿈 금지. `Enter`, `Escape`, `Tab`, `Backspace`, 방향키, `Home`, `End`, `PageUp`, `PageDown`, `Delete`와 한 글자를 지원한다. |
| `terminal.keys.get` | `{type,rid}` |
| `terminal.keys.set` | `{type,rid,keys}`. 최대 24개, `id` 중복 금지. 각 항목은 `{id,label,key,modifiers}`이며 `id` 1–32자 영숫자·`_`·`-`, `label` 1–24자, `key` 1–24자다. |

`terminal.watch.result`는 `{type,rid,agent,revision,text,truncated,hash,columns?,rows?,mouseMode,error?}`다. `terminal.frame`도 `rid`를 제외한 같은 필드를 가진다. 이전 서버의 추가 필드 없는 프레임도 파싱하지만 크기를 확인할 수 없다는 안내를 표시한다. `hash`는 서버의 현재 화면·열·행 수·마우스 모드 SHA-256이며 내부 ID를 포함하지 않는다. herdr revision이 없거나 같은 값이어도 해시가 다르면 300 ms 간격으로 프레임을 전송한다. 입력 직후에도 화면을 읽는다. 입력 후 읽기와 poll이 겹쳐도 다음 poll을 예약한다. visible·recent·크기 조회마다 2초 제한 시간을 적용하며 제한 시간 뒤에도 주기 조회를 이어 간다. 재연결로 복원한 구독의 첫 응답도 폰 화면 스트림에 반영한다.

`text`는 `pane.read`의 `visible`·`ansi` 화면이다. OSC·DCS는 제거하고 SGR·커서 이동·지우기 코드는 유지한다. Mac 경로와 내부 식별자는 기존 공개 정책에 따라 대체하며 원래 셀 폭을 공백으로 맞춘다. 대체 문구보다 짧은 원문은 같은 칸 수의 `•`로 가린다. 이 부분의 원문 글자는 미러링하지 않는다. 화면은 UTF-8 48 KiB와 262,144셀 이하이며 상한 초과나 herdr `truncated:true`는 부분 화면 대신 `text:""`, `truncated:false`, `error:"terminal-frame-too-large"`로 표시한다. JSON 송신 한도 초과도 같은 오류 프레임으로 처리한다. 읽기·크기 조회 실패는 `[remote] terminal-read reason=<사유 코드>` 한 줄로 기록하며 내용은 기록하지 않는다. 제한 시간은 `terminal-read-timeout`이며 폰에 `터미널 읽기 시간이 초과되었습니다. 자동으로 다시 시도합니다.`를 표시한다. visible 원문이 같지만 recent 원문이 세 번 이상 바뀌고 첫 변경부터 2초 이상 지났으면 `terminal-screen-stale`을 보낸다. 폰은 기존 visible 화면과 `출력은 바뀌지만 화면이 갱신되지 않습니다. Mac에서 이 pane을 확인하세요.`를 표시한다. visible이 바뀌면 사유를 해제한다. 조용한 pane은 중단으로 판정하지 않는다. recent 기록은 화면 좌표를 보장하지 않으므로 visible 대신 표시하지 않는다.

`columns`·`rows`는 소유 herdr 클라이언트의 `call("pane.layout", {pane_id})`가 반환한 해당 pane의 `rect.width`·`rect.height`이며 1–4,096이다. 조회 실패 시 문자열 길이로 추정하지 않고 `terminal-layout-unavailable`을 표시한다. Mac pane 크기는 바꾸지 않는다. 폰은 고정 열×행 격자를 셀별 좌표로 그리며 SGR 16색·256색·truecolor, 굵게·기울임·밑줄·반전·흐림, 커서 이동·지우기·alternate screen을 해석한다. 한글·CJK·이모지는 두 칸, 박스 문자·목록 표시는 한 칸을 사용한다. 결합 글자와 ZWJ 이모지는 한 글자 묶음으로 처리한다. 커서는 화면 ANSI에 표시 상태와 위치가 있을 때 그린다. 현재 herdr read 스키마에는 별도 커서 좌표가 없다.

폰은 고정폭 `M`의 실제 글꼴 폭을 측정해 `폰 표시 폭 ÷ pane 열 수`에 맞춰 글자 크기를 계산한다. 최대 16px이며 읽기용 하한을 두지 않는다. 열 수가 많으면 글자가 작아져도 모든 열을 표시한다. 다시 줄바꿈하거나 가로로 스크롤하지 않는다. 세로는 pane 행 수만큼 그려 스크롤할 수 있다.

| 요청 | 필드와 한도 |
|---|---|
| `terminal.select` | `{type,rid,agent,hash,columns,rows,row}`. `hash`는 64자리 소문자 hex, 열·행 수 1–4,096, `row`는 1–rows. |
| `terminal.mouse` | `{type,rid,agent,hash,columns,rows,column,row,action,dy?}`. `column`은 1–columns, `row`는 1–rows. `action`은 `click`, `double`, `context`, `down`, `drag`, `up`, `wheel`. `wheel`만 0이 아닌 -20,000–20,000 정수 `dy`를 받는다. |

두 요청은 현재 연결의 터미널 구독이 같은 agent를 가리켜야 한다. 등록 기기·PIN 인증, 기존 요청 속도 제한, pane 소유 재검사에 더해 연결당 터치 동시 요청 한 개와 최소 100 ms 간격을 적용한다. 입력 전에 최신 화면·마우스 모드·열·행 수를 다시 읽어 해시와 크기를 비교하고 달라졌으면 새 프레임과 `terminal-stale-screen`을 보내며 입력하지 않는다. 입력 직전에 pane과 열·행 수를 재검사한다.

선택 목록은 서버가 최신 화면에서 판정한다. `›`, `❯`, `●`, `○` 표시 또는 `1.`·`2.` 번호가 있는 연속된 후보 줄을 찾고 선택 표시가 하나이며 터치한 행도 그 목록 안일 때만 허용한다. 번호만 있거나 후보 목록이 여러 곳에 있거나 줄 위치를 바꾸는 제어 코드가 남아 있거나 표시가 애매하면 `terminal-selection-unavailable`로 거절한다. 서버가 선택 행과 터치 행의 차이만큼 위·아래 키를 보낸 뒤 Enter를 한 번 보내고 화면을 갱신한다. 같은 행은 Enter만 보낸다. 슬래시 명령·스킬도 같은 판정 규칙을 쓴다. 거절 문구는 `항목을 확인하지 못했습니다. 키 버튼으로 선택하세요`다.

마우스 모드는 최신 `recent` ANSI의 DECSET/DECRST 1000·1002·1003·1006 설정·해제 순서로 판정한다. 1006이 켜지고 1000·1002·1003 중 하나가 켜졌다는 근거가 모두 있어야 `mouseMode:true`다. 원문이 잘렸거나 설정 근거가 없으면 `false`이며 마우스 바이트를 보내지 않는다. 현재 herdr 0.9.1의 read 스키마에는 마우스 상태가 없고 조회한 snapshot에서는 모드 시퀀스가 없었다. 이 경우 폰은 `이 화면은 마우스 입력을 받지 않습니다`를 표시하고 선택 목록 키 조작을 쓴다.

지원 모드에서 왼쪽 누름은 `ESC[<0;column;rowM`, 뗌은 마지막 `m`, 오른쪽은 버튼 2, 끌기는 32, 휠 위·아래는 64·65로 `paneSendText`에 전달한다. 한 번 누르기는 클릭, 두 번은 더블 클릭, 길게 누른 뒤 이동은 누름·끌기·뗌이다. 세로 밀기는 휠이다. 길게 누르고 이동하지 않으면 글자 선택·복사 시트를 연다. 이 시트에는 마우스 지원 화면의 오른쪽 클릭도 제공한다. 마우스 미지원 화면의 세로 밀기는 화면 글자 보기 스크롤이다. 화면 위쪽에서 아래로 밀면 `terminal.scrollback`으로 최근 기록을 불러온다. 기록 중에는 터치 입력을 보내지 않고 `현재 화면으로` 버튼으로 돌아간다. 요청은 `{type,rid,agent}`, 결과는 `{type:"terminal.scrollback.result",rid,agent,text,columns,lineCount}`다. `columns`는 실제 pane 열 수이고 `lineCount`는 최근 기록의 줄 수다. 기록도 UTF-8 48 KiB 또는 열 수×기록 줄 수 262,144셀을 넘거나 herdr에서 잘렸으면 부분 기록을 표시하지 않고 `terminal-frame-too-large`로 거절한다. 복사는 폰 클립보드만 사용하며 디스크 저장과 두 손가락 확대는 추가하지 않는다.


`agent.message`는 `{type,rid,agent,text,drafts?}`다. `text`는 최대 4,000자이며 `drafts`가 있으면 빈 문자열도 허용한다. `drafts`는 같은 연결과 에이전트에 발급된 붙여넣기 ref를 중복 없이 최대 8개 보낸다. 서버는 사용자 글 뒤에 각 원문을 빈 줄로 구분해 붙인 다음 Claude 메시지 채널을 쓴다. 채널이 없는 Claude 세션은 CR과 CRLF를 LF로 바꾼 본문을 bracketed paste로 등록된 pane에 넣고, 붙여넣기 종료 뒤 Enter를 한 번 보낸다. 본문 검사는 ESC와 다른 제어 문자를 거부하므로 본문이 붙여넣기 종료 표시를 만들 수 없다. 셸 명령 문자열을 만들지 않으며 다른 pane에는 보내지 않는다. 성공 응답은 실제 입력 호출이 끝난 뒤 `sent`, 실패하면 `failed`다. 서버는 성공 뒤 붙여넣기 원문을 폐기하고 해당 대화 기록 구독을 바로 다시 확인한다.

Agent ref는 pane과 현재 세션 UUID를 함께 가리킨다. 일반 터미널은 pane과 terminal 식별자를 묶는다. 목록과 입력 전에 소유 함수 `paneList`로 현재 pane을 확인하며 pane이 닫히거나 terminal 식별자가 달라지거나 에이전트가 붙으면 이전 터미널 ref를 거부한다. 같은 pane의 세션 UUID가 바뀌면 새 ref를 발급하고 이전 ref 요청은 `forbidden`이다. `agent.message`, `terminal.input`, `terminal.key`는 pane에 입력하기 직전에 ref가 아직 같은 세션을 가리키는지 다시 확인한다.

`terminal.keys`는 `{type,rid,keys,defaults,macShortcuts}`다. `keys`와 `defaults`의 항목은 저장 요청과 같다. `macShortcuts` 항목은 `{id,label,keys}`이며 현재 Mac 단축키에서 얻을 수 있는 후보를 최대 40개 보낸다. 저장 위치는 Mac별 `stateHome()/remote/phone-key-row.json`이다.

## 4. 브라우저 요청

대화 파일 링크는 서버 메모리에 원문 경로를 남기고 `iris-media:<32자리 ref>`로 투영한다. ref는 에이전트에 묶이고 최대 4,096개이며 서버가 재시작하거나 보관 한도를 넘으면 만료된다. PDF·HTML·PNG·JPEG·GIF·WebP·SVG의 절대 경로, file URL, 상대 경로를 인식한다. 상대 경로의 기준은 현재 에이전트 cwd다. 열기를 누를 때 실제 경로를 다시 확인하며 홈 디렉터리 밖, 상태 폴더 안, 존재하지 않는 파일, 허용 확장자가 아닌 파일, 2,048자를 넘는 경로와 URL은 거부한다. 심볼릭 링크도 실제 경로로 판정한다. HTTP(S) 외의 URL은 파일 ref 경로를 제외하고 모두 거부한다. 허용 파일은 데스크톱 문서 열기와 같은 file URL로 Mac의 Iris 탭 상태에 등록하며 파일 내용이나 Mac 경로를 폰에 보내지 않는다.

대화 화면과 터미널 화면의 브라우저 버튼은 같은 에이전트의 세션 탭, 같은 스페이스 활성 탭, 같은 스페이스 첫 탭 순서로 선택한다. 해당 스페이스에 탭이 없으면 `이 스페이스에 브라우저 탭이 없습니다`를 표시하며 다른 스페이스나 공유 탭으로 이동하지 않는다. 브라우저에서 터미널을 거쳐 돌아갈 때도 같은 순서를 사용한다.

### 4.1 목록과 화면

- `browser.tabs`: `{type,rid}`
- 결과: `{type:"browser.tabs.result",rid,spaces,groups,tabs}`
- `spaces[]`: `{ref,name}`
- `groups[]`: `{ref,space,name,collapsed,color?}`. 그룹 ref는 스페이스와 내부 그룹 ID를 함께 묶어 기존 불투명 ref 방식으로 발급한다. 내부 ID는 보내지 않는다. 폰 브라우저 상단은 현재 스페이스 탭을 그룹별로 묶고 그룹 이름·색·접힘 상태를 표시한다. 처음에는 서버 접힘 상태를 쓰며 이후 폰의 펼침·접힘은 화면 안의 보기 상태다. Mac 그룹 상태를 바꾸는 요청은 없다. 현재 선택 탭과 프레임 구독은 그룹을 접어도 유지한다. 홈의 스페이스→세션→사용자 탭 묶음은 유지하며 각 탭에 그룹 이름을 표시한다. 구버전 `groups` 누락은 빈 목록으로 읽는다.
- `tabs[]`: `{ref,space,title,url,profile,aiControlled,controlling,active,sleeping,sessions?,group?}`. `space`는 Agent.spaceRef와 같은 불투명 ref이며 스페이스 순서는 홈의 spaceOrder를 따른다. `group`은 같은 스페이스의 공개 그룹 ref다. `sessions`는 탭 그룹·현재 탭·보유 탭의 소유 pane에 대응하는 Agent.ref 배열이다. pane ID와 그룹 ID는 공개하지 않는다. 폰은 스페이스 안에서 sessionOrder대로 세션 탭을 묶고 나머지를 `사용자 탭`으로 표시한다. 여러 세션이 가진 탭은 각 세션 묶음에 표시한다. 이전 서버에 sessions가 없으면 빈 배열로 읽는다. `controlling`에는 화면에 표시할 에이전트 이름만 들어간다. HTTP(S)가 아닌 주소는 빈 문자열이다.
- `browser.frame.watch`: `{type,rid,tab,width,fps,desktop}`. `width` 240–2,560, `fps` 1–4, `desktop` boolean. 연결당 한 탭이며 새 요청이 이전 화면 구독을 바꾼다. 폰은 `논리 화면 폭 × 기기 픽셀 비율 × 확대 배율`로 폭을 계산하고 최대 2,560까지 요청한다. 데스크톱 보기는 최소 1,280이다.
- 수락 응답: `{type:"browser.frame.watch.result",rid,tab,watching:true}`
- 프레임 푸시: `{type:"browser.frame",tab,seq,width,height,jpeg}`. `jpeg`는 data URL 접두사 없는 base64이며 JPEG 원문은 최대 384 KiB다. 서버는 요청 폭에서 JPEG 품질 78, 68, 58, 48을 차례로 시도하고 넘으면 폭을 85%, 70%, 55%로 낮춘다. 서버는 직전 프레임과 SHA-256이 다를 때만 보내며 `desktop:true`면 최소 720px 폭을 사용한다.

프레임 구독과 브라우저 조작은 탭 상태에 `webContents`가 없으면 기존 Iris 탭 깨우기 함수로 해당 탭을 먼저 준비하고 최대 12초 기다린다. 프레임 구독은 첫 화면 캡처와 JPEG 384 KiB 변환이 끝난 뒤 수락한다. 준비·캡처가 실패하면 아래 브라우저 오류 코드로 답하며 빈 화면 구독을 남기지 않는다.

### 4.2 조작

| 요청 | 필드와 한도 |
|---|---|
| `browser.pointer` | `{type,rid,tab,x,y,width,height,action}`. 좌표 0–4,096, 폰 화면 크기 1–4,096, `action:"click"|"double"`. 서버가 페이지 좌표로 비례 변환한 뒤 Iris 브라우저 실행기에 전달한다. 등록 기기 서명과 접속 PIN을 통과한 연결만 요청할 수 있다. |
| `browser.mouse` | `{type,rid,tab,x,y,width,height,action,dy?}`. 좌표와 크기 한도는 `browser.pointer`와 같다. `action`은 `move`, `click`, `double`, `context`, `wheel`, `down`, `drag`, `up`이다. `context`는 오른쪽 버튼 누르기다. `wheel`만 0이 아닌 `dy` -20,000–20,000을 받는다. 서버가 받은 프레임 좌표를 현재 페이지 CSS 뷰포트 좌표로 비례 변환한 뒤 CDP `Input.dispatchMouseEvent`에 전달한다. |
| `browser.type` | `{type,rid,tab,text}`. 1–4,000자, 제어 문자 금지. |
| `browser.key` | `{type,rid,tab,key,modifiers}`. `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, 방향키, `Home`, `End`와 보조 키를 받는다. 입력칸·글 영역·`contenteditable`의 값, 커서, 포커스를 페이지 안에서 바꾼다. |
| `browser.scroll` | `{type,rid,tab,dy}`. 0을 제외한 -20,000–20,000 정수. |
| `browser.history` | `{type,rid,tab,action}`. `back`, `forward`, `reload`. |
| `browser.navigate` | `{type,rid,tab,url}`. HTTP(S), 1–2,048자, 공백·제어 문자 금지. |
| `browser.tab.new` | `{type,rid,space,url?,title?,profile?,agent?,media?}`. `agent`가 있으면 현재 Agent.ref와 spaceRef를 다시 확인한다. `media`는 agent가 필수이며 url과 함께 보낼 수 없다. URL은 HTTP(S), `title` 1–80자, `profile` 1–60자. 기본 주소는 Google, 기본 제목은 `폰에서 연 탭`. | 성공 응답은 `{type:"remote.action.result",rid,result:"done",tab}`이며 `tab`은 방금 만든 탭의 공개 ref다.
| `browser.desktop` | `{type,rid,tab,enabled}`. 켜면 1,280×800, 끄면 viewport 강제값을 없앤다. |
| `browser.translate` | `{type,rid,tab}`. HTTP(S) 페이지를 Iris 페이지 번역 기능에서 선택한 언어로 번역한다. |
| `browser.direct` | `{type,rid,tab}`. 해당 탭의 현재 AI 조작 표시와 최근 AI 사용 표시를 지운다. |

조작 성공은 `{type:"remote.action.result",rid,result}`다. `result`는 `done`, 상태가 같으면 `unchanged`, 에이전트나 pane으로 전달했으면 `sent`다. 폰 조작 자체는 AI 조작 표시를 만들지 않는다.

`caps.requests`에 `browser.mouse`가 있으면 폰의 기본 브라우저 조작은 터치패드다. 화면 가운데에서 시작하는 별도 커서를 표시하고 한 손가락 이동을 최대 150ms마다 마지막 위치 하나로 묶어 `move`로 보낸다. 가볍게 한 번·두 번 누르면 커서 위치에 `click`·`double`, 길게 누른 뒤 움직이면 `down`·`drag`·`up`, 두 손가락 평행 이동은 커서 위치의 `wheel`을 보낸다. 더보기의 오른쪽 누르기는 커서 위치에 `context`를 보낸다. 두 손가락 거리 변화는 폰 화면 확대·축소이며 확대를 시작한 같은 제스처로 확대 화면을 이동한다. 확대된 화면에서 커서가 가장자리 안전 영역을 벗어나면 화면 위치가 커서를 따라 이동한다. 확대·이동 뒤에도 커서 위치는 원본 프레임 좌표로 역변환한다.

더보기의 `직접 누르기`로 바꾸면 손가락 위치에 기존 `browser.pointer`를 보낸다. `browser.pointer`는 좌표에서 DOM 요소를 찾은 뒤 selector 클릭을 실행하므로 좌표 마우스 입력과 결과가 다를 수 있다. `browser.mouse`가 capability에 없으면 폰은 터치패드 전환과 커서를 표시하지 않고 직접 누르기를 사용한다. 스케치는 손가락으로 그리므로 커서를 표시하지 않는다. 주소 입력은 바깥을 누르면 초점을 풀고 편집 중인 주소는 남긴다. 주소 입력의 `browser.navigate`와 두 클릭 경로는 원격 WebSocket의 `browser-sync` 변경 경로를 사용하지 않고 인증된 원격 처리표에서 Iris 브라우저 실행기를 호출한다.

좌표 클릭 뒤 폰은 `browser.dialog`과 `browser.focus`를 확인한다. 입력 가능한 요소에 초점이 있으면 폰 키보드를 열고 조합 중인 글자는 보내지 않으며 확정된 글자를 `browser.type`으로 최대 4,000자씩 보낸다. 지우기·Enter·Tab·방향키·Esc는 `browser.key`로 보낸다. 붙여넣기는 폰 클립보드 글자를 `browser.type`으로 보내며 복사는 `browser.focus.result.selectedText`를 폰 클립보드에 넣는다. 입력할 수 없는 곳을 누르거나 키보드를 내리면 입력 도구를 닫는다. 서버 요청은 다른 조작과 함께 연결당 1초 9개 이하로 보낸다. 이동·끌기·hover·휠은 전송 중인 값과 최신 대기값 하나만 남기며, 클릭·키·확정 글자는 요청 순서와 개수를 보존한다. 연결이 바뀌면 이전 연결의 대기 요청은 새 연결로 보내지 않는다.

인증 후 서버 요청 제한은 평균 초당 40개, 짧은 몰림 60개다. 60개를 다 쓴 뒤의 요청은 `limit-exceeded`로 거절하되 연결은 유지한다. 동시에 처리하는 요청은 16개까지이며 초과분은 `busy`다. 게이트웨이와 호스트의 전송 프레임 제한은 평균 초당 50개, 짧은 몰림 90개다. 90개를 소진한 지속 남용은 `rate-limit`으로 연결을 닫아 IPC와 Mac 작업을 보호한다. 인증 전 제한은 초당 5개다. 서버가 연결을 닫으면 `server.log`에 기기·토큰·요청 내용 없이 이유 코드 한 줄만 남긴다.

`browser.dialog`은 `alert`, `confirm`, `prompt`, `beforeunload`를 폰 시트로 표시한다. 클릭 직후와 마지막 클릭 900ms 뒤에 확인해 지연 대화상자를 받는다. 늦은 확인 때 탭 목록도 다시 받아 페이지가 연 새 탭과 팝업을 폰 탭 목록에 표시한다. 새 끌기나 키 입력이 시작되면 늦은 확인을 취소해 현재 조작을 먼저 보낸다. `prompt` 수락만 `text`를 보낸다. `select`는 페이지에서 초점을 받은 뒤 방향키와 Enter로 조작한다.

### 4.3 요소·기록·스케치

- `browser.element`: `{type,rid,tab,x,y,width,height}`. 좌표 한도는 `browser.pointer`와 같다.
- 결과: `{type:"browser.element.result",rid,element}`. 요소가 없으면 `element:null`, 있으면 `{selector,text,rect:{x,y,width,height}}`다. `text`는 최대 300자다.
- `browser.element.hover`: `browser.element`와 같은 요청이다. 결과는 `{type:"browser.element.hover.result",rid,viewport:{width,height},element}`다. 폰은 `viewport`에 맞춰 요소를 프레임 위에 표시한다. 데스크톱과 같은 `#F4A1A7` 테두리·채움·어두운 글자의 이름표를 쓰며, 폰 프레임 축소 뒤에도 보이도록 테두리는 3px, 채움은 24%로 높인다. 이름표에는 선택자와 요소 크기를 적는다. 요소 선택 중에도 터치패드 커서를 표시하며 이동 요청은 최대 150ms마다 마지막 좌표 하나로 묶는다. 선택 버튼을 다시 누르거나 다른 도구·탭·화면으로 이동하거나 재연결을 시작하면 강조를 즉시 지우며, 그 전에 보낸 hover 응답은 다시 표시하지 않는다.
- `browser.element.pick`: 요소 요청 필드에 `agent`를 더한다. 선택한 요소를 `browser.draft.result`로 돌려주며 요소 선택 상태를 유지해 연속으로 고를 수 있다. 본문은 데스크톱 선택과 같은 `⟦Iris⟧ 요소 선택 #pN` 블록이며 선택자·HTML, React·Vue 개발 소스, 확인된 소스·스타일·동작 코드 위치와 선택 순간의 요소 그림을 포함한다. 폰 칩의 표시용 본문은 Mac 절대 경로를 `[Mac 경로]`로 바꾸지만 에이전트에 보내는 본문은 실제 경로를 유지한다.
- `browser.focus`: `{type,rid,tab}`. 결과는 `{type:"browser.focus.result",rid,editable,kind,multiline,selectedText}`다. `kind`는 `none`, `text`, `multiline`, `select`다. `selectedText`는 최대 4,000자다.
- `browser.dialog`: `{type,rid,tab,action,text?}`. `action`은 `get`, `accept`, `cancel`이다. `accept`에만 0–2,000자의 `text`를 보낼 수 있다. 결과는 `{type:"browser.dialog.result",rid,dialog}`이며 열린 창이 없으면 `dialog:null`, 있으면 `{kind,message}`다. `kind`는 `alert`, `confirm`, `prompt`, `beforeunload`, `message`는 최대 300자다.
- `browser.element.send`: 요소 요청 필드에 `agent`, `text`를 더한다. `text` 1–2,000자. 요소 정보와 글을 서버의 붙여넣기 원문으로 보관한다.
- `browser.record.start`: `{type,rid,tab}`. 이 연결에서 이후 성공한 pointer, mouse의 click·double·wheel, type, key, scroll, history, navigate를 최대 200단계 기록한다.
- `browser.record.pause`: `{type,rid,paused}`. `true`는 일시 정지, `false`는 재개다.
- `browser.record.finish`: `{type,rid,agent,note?}`. `note` 1–2,000자. 기록을 붙여넣기 원문으로 보관한 뒤 기록 상태를 지운다.
- 기록 시작·일시 정지 응답: `{type:"browser.record.result",rid,state,steps,elapsedMs}`. `state`는 `recording`, `paused`다. `elapsedMs`는 기록을 시작한 뒤 지난 밀리초다. 각 단계는 1–500자다.
- `browser.sketch.send`: `{type,rid,agent,tab,image,text}`. `image`는 `data:image/png;base64,...` 또는 `data:image/jpeg;base64,...`, 문자열 48 KiB 이하, 디코딩 결과 36 KiB 이하. `text` 1–2,000자. 서버가 Mac의 제한된 원격 상태 폴더에 그림을 저장하고 경로를 포함한 원문을 서버에 보관한다.
- 위 세 요청의 성공 응답은 `{type:"browser.draft.result",rid,ref,kind,summary,content}`다. `kind`는 `element`, `record`, `sketch`, `summary`는 1–80자, `content`는 최대 128K자다. 한 연결이 보관하는 본문은 UTF-8 기준 합계 384 KiB 이하다. 스케치의 `content`는 저장 경로 대신 `Mac에 저장됨`을 표시한다. 폰은 결과를 해당 에이전트 대화 입력칸의 칩으로 표시하고, 칩을 누르면 전체 내용을 스크롤·복사할 수 있는 시트를 연다.
- 원문은 연결당 최대 8개이며 다른 연결이나 에이전트에서 ref를 쓸 수 없다. `browser.draft.remove`는 `{type,rid,ref}`이며 칩 삭제와 함께 서버 원문을 지운다. 연결 종료 때 남은 원문을 모두 지운다.
- 폰은 기록·스케치 결과를 입력칸에 추가한 뒤 브라우저 화면을 닫고 해당 에이전트의 대화 입력칸에 초점을 둔다. `browser.element.pick`은 브라우저 화면과 요소 선택 상태를 유지한다.
- 전송된 `user` 대화가 `[브라우저 요소]`, `[폰 브라우저 조작 기록]`, `[폰 화면 스케치]`로 시작하는 블록을 포함하면 폰은 기록에서도 같은 칩으로 접는다. 블록 앞에 사용자가 쓴 글이 있으면 글은 그대로 표시한다.

### 4.4 프로필과 북마크

- `browser.profiles`: `{type,rid}` → `{type:"browser.profiles.result",rid,profiles:[name]}`. 이름은 1–60자다.
- `browser.profile.set`: `{type,rid,tab,profile}`. `profile`은 목록에 있는 이름이며 1–60자다.
- `browser.bookmarks`: `{type,rid,space}` → `{type:"browser.bookmarks.result",rid,bookmarks}`. 최대 200개. 항목은 `{title,url,folder}`이고 `folder`는 문자열 또는 `null`이다.
- `browser.bookmark.set`: `{type,rid,tab,bookmarked}`. `true`는 추가, `false`는 삭제다.

## 5. 사람 차례 요청

### 5.1 Claude 질문과 터미널 답변

Claude 질문 hook은 같은 사용자 소켓에 hello와 질문을 보내고 응답을 기다리지 않고 빈 출력으로 끝난다. 연결 제한은 250ms, 프로세스 제한은 300ms, 설치 timeout은 1초다. 같은 command의 기존 600초 설치 항목은 설치를 다시 요청하면 1초로 갱신한다. `question.answer`와 updatedInput 답 경로는 사용하지 않는다. 질문을 받은 서버는 원격 공유·등록 기기·pane·CLI 세션·입력 형식을 검사하고 메모리에 보관한다. 터미널 질문은 Claude의 평소 실행 경로로 표시된다.

터미널로 넘긴 질문은 서버 메모리에만 보관한다. 한 pane에 최신 질문 하나, 서버 전체 최대 32개, projection JSON 합계 32 KiB, 최대 24시간이다. 입력 questions는 최대 4문항·16 KiB이며 선택지 `preview`는 검사 뒤 제외한다. 보관과 조회 때 pane, Agent.ref, CLI 세션을 다시 확인한다. 해당 세션의 `source.question` 또는 `status:blocked`가 유지되는 동안 재표시하며 Mac 답변 뒤 상태 해제, 세션 종료·교체, 새 질문, 보관 기한 만료 때 제거한다. hook 종료와 터미널 상태 갱신 사이에는 최대 20초를 허용한다.

caps의 `session.watch`는 `{type:"session.watch",rid}`다. 등록 기기와 PIN 인증 뒤에만 처리한다. 최초 연결·재연결·재호출 때 `agents`, `requests`, 아래 응답을 전송하고 이후 변경도 구독한다. 빈 배열은 폰의 보관 질문 표시를 지운다.

```json
{"type":"terminal.questions","questions":[{"ref":"32자리 hex","agent":"Agent.ref","kind":"claude-question","createdAt":1,"expiresAt":86400001,"body":{"questions":[{"question":"질문","header":"제목","multiSelect":false,"options":[{"label":"선택지","description":"설명"}]}]}}]}
```

응답과 항목의 키는 위 목록만 허용하며 기존 request projection 검사도 적용한다. 보관 질문 ref는 `request.answer`로 답할 수 없다. 폰 홈의 답 대기 목록 위와 해당 세션 대화 화면에 질문과 선택지를 표시하며 `터미널에서 답하기`로 기존 터미널 화면을 연다. 선택지는 키 입력을 보내지 않는다. `terminal.watch`와 `terminal.key`가 caps에 있을 때 표시한다. 홈의 `동기화` 버튼은 `session.watch`를 다시 요청한다.

기존 `watch`도 재호출할 수 있으며 기존 `agents`, `requests` 응답만 받는다. 새 폰은 `session.watch`가 caps에 없는 서버에서 `watch`를 사용한다. 이전 앱 파서는 모르는 메시지에 오류를 내지만 인증 후 읽기 루프는 그 오류를 무시한다. 새 보관 질문 응답은 `session.watch`를 요청한 연결에만 보낸다.

서버가 받은 질문을 폰에 보내지 못하면 질문 내용·경로 없이 `[remote] question reason=<코드>` 한 줄을 남긴다. 코드는 `no-phone`, `phone-disconnected`, `remote-disabled`, `no-device`, `validation-rejected`, `expired`다.

### 5.2 브라우저 사람 차례

폰에서는 선택지를 지정하지 않은 `browser_ask_user` 요청에 답할 수 있다. 기존 `watch`의 `requests` 목록에서 아래 항목을 확인한다. 승인 요청과 지정 선택지가 있는 질문은 Mac에서 답한다.

```json
{
  "ref":"32자리 hex",
  "agent":"Agent.ref",
  "kind":"browser-user",
  "createdAt":0,
  "expiresAt":0,
  "body":{"title":"사람 차례","text":"설명","choices":["다 했음","못 하겠음"],"tab":"선택 필드 Tab.ref"}
}
```

`title`은 1–60자, `text`는 1–500자, 선택지는 위 두 개다. 답은 `{type:"request.answer",rid,request,answer:{choice:"done"|"unable"}}`다. Mac 화면과 폰 가운데 먼저 도착한 유효 답 하나만 적용한다. 이미 답한 원격 요청은 `already-answered`, Mac에서 답해 취소된 요청은 `expired`를 반환한다.

만료된 요청은 자동으로 다시 표시하지 않는다. AI가 같은 질문을 다시 요청하면 새 `ref`로 답할 수 있고 이전 `ref`로는 답할 수 없다. Mac에서 답한 질문도 폰의 요청 목록에서 제거한다.

## 6. Git과 GitHub 요청

- `git.changes`: `{type,rid,agent}`
- 결과: `{type:"git.changes.result",rid,branch,ahead,behind,base,commitCount,additions,deletions,files,bases}`. `base`는 비교 기준 브랜치다. `commitCount`와 전체 `additions`·`deletions`는 기준 브랜치 대비 값이며 계산할 수 없으면 `null`이다. `files`는 최대 500개이며 `{ref,path,code,staged,untracked,additions,deletions}`다. 파일별 증감도 계산할 수 없으면 `null`이다. `path`는 저장소 상대 경로다. `bases`는 비교할 브랜치 이름이며 최대 200개다.
- `git.diff`: `{type,rid,agent,file,view,base?}`. `view`는 `working`, `staged`, `branch`. `base`는 `branch`일 때 쓰며 1–200자다.
- 결과: `{type:"git.diff.result",rid,file,patch,truncated}`. `patch`는 UTF-8 48,000바이트 이하다. diff 헤더의 파일 경로는 작업 폴더 기준 상대 경로다. 서버가 자르면 `truncated:true`다.
- `git.diff.draft`: `{type,rid,agent,file,side,line,text}`. `side`는 `old` 또는 `new`, `line` 1–10,000,000, `text` 1–4,000자다.
GitHub capability는 `gh` 실행 파일 설치 여부로 결정한다. 로그인 여부는 요청 결과로 확인한다. 오류 응답은 기존 `{type:"error",rid,error:{code}}`이며 `gh_missing`, `auth_required`, `no_pr`, `no_remote`, `not_github`, `timeout`, `output_limit`, `command_failed`, `bad_response`, `unsupported_host`, `invalid_run`을 허용한다. 폰은 코드마다 설치 없음·미로그인·PR 없음·원격 없음·GitHub 아닌 저장소·응답 지연 등을 구분해 표시한다. `unsupported-request`는 요청 타입이 없는 서버의 응답에만 사용한다. caps에 없는 기능의 버튼은 숨긴다.

- `github.pr`: `{type,rid,agent}` → `{type:"github.pr.result",rid,pr}`. `pr`에는 `number,title,url,state,isDraft,head,base,author,body,comments,reviews,reviewComments,files,checks,reviewCommentsLimited,reviewCommentsError`만 들어간다. `checks[].runId`가 있으면 로그 요청에 쓴다.
- `github.check.log`: `{type,rid,agent,run}`. `run`은 숫자 1–18자리이며 현재 PR의 검사여야 한다.
- 결과: `{type:"github.check.log.result",rid,run,log,truncated}`. `log`는 UTF-8 40,000바이트 이하다. 서버가 자르면 `truncated:true`다.
- `github.check.draft`: `{type,rid,agent,run,text?}`. `text` 1–2,000자. 서버가 실패 로그와 글을 에이전트 입력창에 넣는다.

## 6-1. Paseo 대화 화면

`caps.get` 의 `requests` 에 `chat.open` 이 있으면 폰이 에이전트의 Paseo 대화 화면을 열 수 있다. 화면은 Mac 의 Iris 서버가 빌드한 Paseo UI(`/paseo-ui/`)이고, 대화 데이터는 이 연결로 받아 웹뷰에 넣는다. Paseo 데몬은 쓰지 않는다.

| 요청 | 모양 | 응답 |
|---|---|---|
| `paseo.open` | `{type,rid}` | `{type:"paseo.open.result",rid,ticket}` 30초 안에 한 번만 쓰는 64자리 hex 티켓 |
| `chat.open` | `{type,rid,agent}` agent 는 Agent.ref | `{type:"chat.open.result",rid,key}` key 는 32자리 hex. 연결마다 4개까지 |
| `chat.older` | `{type,rid,key}` | `remote.action.result` 이전 대화를 `chat.older` 로 보냄 |
| `chat.close` | `{type,rid,key}` | `remote.action.result` |

서버가 보내는 푸시는 아래와 같다. 모든 프레임은 64 KiB 안이며 큰 메시지는 잘려서 온다.

- `{type:"chat.ui",phase,message,version?,url?}`: 화면 빌드 상태. `phase` 는 `none|building|ready|error`. `ready` 일 때 `url` 은 `/paseo-ui/?v=<버전>`. `chat.open` 직후와 상태가 바뀔 때 온다. 빌드는 첫 `chat.open` 이 시작한다.
- `{type:"chat.frame",key,kind,messages,hasOlder?}`: `kind` 는 `snapshot|replacement|append`. 한 묶음이 상한을 넘으면 첫 묶음만 원래 `kind` 와 `hasOlder` 를 갖고 나머지는 `append` 다.
- `{type:"chat.frame",key,kind,reason}`: `kind` 는 `missing|error`.
- `{type:"chat.older",key,messages,hasOlder}`: 앞쪽에 붙일 메시지. 여러 묶음이면 가장 뒤쪽 묶음부터 온다.
- 메시지는 `{id,role,ts,blocks}`. `chat.frame` 은 `chat.open.result` 보다 먼저 올 수 있어 폰은 응답 전에 온 프레임을 모아 둔다. 이미지 블록은 `{type:"image",off,i}` 이고 데이터가 없다. 폰은 `key` 를 pane 값으로 써서 `/agentchat-image?pane=<key>&agent=&off=&i=` 를 부른다.

웹뷰 접속은 `remote/1` 과 같은 주소·포트·인증서 고정을 쓴다.

- 웹뷰는 `GET /.iris-paseo/enter?t=<ticket>` 을 연다. 서버는 `Host` 가 `<Tailscale 주소>:<포트>` 이고 요청한 소켓의 Tailscale 노드가 티켓을 받은 연결의 노드와 같을 때만 받는다. 성공하면 `303 Location: /paseo-ui/` 와 `__Host-iris-paseo` 쿠키(`Secure; HttpOnly; SameSite=Strict; Path=/`)를 준다.
- 쿠키가 있는 `GET` 만 전달한다. 전달하는 경로는 `/paseo-ui/**` 와 `/agentchat-image` 뿐이고 나머지와 WebSocket 업그레이드는 받지 않는다. 쿠키가 없거나 `Origin` 이 있는데 `https://<Host>` 가 아니면 받지 않는다.
- `/agentchat-image` 의 `pane` 은 `chat.open` 이 준 `key` 만 받고 서버가 진짜 pane 으로 바꾼다. 모르는 값과 `agent` 쿼리가 있는 요청은 거절한다.
- `/agentchat-file`(답변 속 로컬 이미지 파일)은 전달하지 않는다. 폰이 경로를 정해 Mac 의 파일을 읽는 통로가 되기 때문이다. 그래서 답변 마크다운이 가리키는 로컬 이미지 파일은 폰에서 표시되지 않는다.
- 메시지의 문자열에서 Mac 절대 경로와 세션 식별자는 `[Mac 경로]`·`[내부 식별자]` 로 가려 보낸다. `role` 은 서버가 해석한 값(`user`, `assistant`, `reasoning`, `tool`, `system` 등)이고 `ts` 는 해석하지 못하면 `null` 이다.
- 쿠키·pane 값은 티켓을 발급한 `remote/1` 연결에 묶인다. 그 연결이 닫히면(PIN 기한 만료, 기기 해제, 원격 끄기, 단절 포함) 쿠키와 열린 전달 소켓이 즉시 끊긴다. 폰에서 자기 기기를 해제하면 응답용 연결이 잠시 남지만 쿠키는 해제와 함께 끊긴다. 폰은 다시 인증한 뒤 `paseo.open` 으로 새 티켓을 받아 웹뷰를 다시 연다.

## 7. 오류

모든 실패는 `{type:"error",rid?,error:{code}}`다. 요청에서 유효한 `rid`를 읽었으면 그대로 돌려준다.

| 코드 | 뜻 |
|---|---|
| `invalid-request` | 필드 누락, 모르는 키, 타입·길이·범위 위반 |
| `unsupported-request` | 이 서버가 모르는 요청 이름 |
| `expired` | 답하려는 요청 만료 |
| `forbidden` | ref가 없거나 다른 에이전트·스페이스 소유, 허용되지 않은 URL·검사 |
| `busy` | 동시 요청 상한 또는 작업 중 에이전트 입력창 |
| `limit-exceeded` | 연결·요청·출력 상한 초과 |
| `unavailable` | 파일, `git`, `gh`, 대상 pane 등 요청한 Mac 기능을 현재 쓸 수 없음 |
| `terminal-frame-too-large` | 터미널 화면 48 KiB 또는 JSON 상한 초과, 부분 화면 표시 금지 |
| `terminal-layout-unavailable` | pane 열·행 수 조회 실패 |
| `terminal-read-unavailable` | pane 화면 읽기 실패 |
| `terminal-read-timeout` | 화면·최근 기록·크기 조회의 2초 제한 시간 초과 |
| `terminal-screen-stale` | visible은 고정되고 recent 변경이 반복됨 |
| `terminal-stale-screen` | 터치가 가리키는 화면 또는 열·행 수 변경 |
| `terminal-selection-unavailable` | 선택 목록 또는 현재 선택 항목 판정 실패 |
| `terminal-mouse-unavailable` | 마우스 보고 모드 확인 불가 또는 해제 상태 |
| `browser-controller-unavailable` | Iris 브라우저 CDP 실행기가 연결되지 않음 |
| `browser-tab-unavailable` | 저장된 탭을 Iris 브라우저 창이 12초 안에 준비하지 못함 |
| `browser-frame-unavailable` | 화면 캡처 경로, JPEG 변환 또는 42 KiB 제한을 충족하지 못함 |
| `browser-command-unavailable` | CDP 명령이 실패하거나 30초 안에 끝나지 않음 |

폰은 `caps.requests`에 없는 기능을 숨기거나 비활성화한다. 모든 오류 코드를 사유별 문구와 사용자가 Mac에서 할 일로 표시한다. `unavailable`과 브라우저 오류는 같은 요청을 즉시 반복하지 않고 Mac 상태가 바뀐 뒤 `caps.get`과 목록 요청을 다시 보낸다.
직접 응답이 64 KiB 송신 한도를 넘고 해당 응답에 잘림 필드가 없으면 서버는 원래 응답 대신 `limit-exceeded`를 보낸다.

### 폰 응답 요청 알림

폰은 `requests`의 claude-permission·claude-question·browser-user와 `terminal.questions`를 요청 ref로 합친다. 같은 ref는 한 번만 센다. 해당 에이전트의 요청이 없으면 kind가 terminal이 아닌 에이전트 중 `question:true` 또는 `status:"blocked"`를 에이전트 ref·status·question 조합으로 센다. 기존 서버 메시지와 인증·유휴 종료 계약은 유지한다.

이 집합에 새 식별자가 들어오면 Android 알림을 울린다. 앱이 전면이고 현재 대화·터미널 화면에서 해당 에이전트를 보고 있으면 그 항목은 울리지 않는다. 개수 감소는 조용히 갱신하고 0건이면 제거한다. 문구는 내용 없이 `응답 요청 N건`이며 누르면 홈의 응답 대기 항목이 있는 처음으로 이동한다. 연결 종료 알림은 `연결이 끊겼습니다`를 유지한다.

Android 요청 채널은 `iris.remote.requests.v2`와 IMPORTANCE_HIGH를 사용한다. 이전 `iris.remote.requests` 채널은 삭제한다. Flutter의 `iris.remote/keepalive` update는 `requestCount`와 `alert`를 전달하고, Android는 `openResponses` 클릭을 전달한다. 초기 실행의 클릭은 `takeOpenResponses`로 한 번 소비한다. 이 상태는 메모리에만 유지하며 알림에는 질문·명령·답 내용을 넣지 않는다.

### 터미널 화면 질문 (packet 66)

`caps.requests`의 `terminal.prompts`는 화면 질문 지원 표시다. 해당 값을 아는
폰만 `session.watch`에 `prompts: true`를 보낸다. 생략하거나 false이면 기존
`claude-question` 보관 항목만 전송하므로 이전 앱에 새 종류가 전달되지 않는다.

`terminal.questions.questions`는 `terminal-prompt`도 포함한다. 본문은 기존
`questions`와 `screen`이다. `screen`에는 `question`(1000자), `options`(2~12개,
각 `row`, 원문 `text` 300자, `selectable`), `selectedRow`, `multiSelect`, `hash`,
`columns`, `rows`가 있다. pane·세션 식별자는 공개하지 않는다.

인증 후 해당 구독이 있을 때만 blocked/question 에이전트 화면을 조회한다.
매 회차 최대 4개를 순환 조회하고 회차 종료 후 1초 대기한다. 각 herdr 호출은
기존 2초 제한을 사용한다. 화면 해시가 바뀔 때만 해석한다. 연속된 목록과
유일한 현재 선택 표시가 없거나 화면 제어·크기 오류가 있으면 직접 선택을 제공하지 않는다.
`promptFallback:true` 연결에는 터미널로 가는 카드를 제공한다. 기존 요청이 있는
에이전트는 제외하며 보관 질문은 화면과 결합한다. 화면 변경·상태 해제 시 삭제하며
삭제한 화면의 식별자 최대 128개를 메모리에 보관해 재표시를 막는다.

카드의 선택은 기존 `terminal.watch` 후 원래 카드의 해시·치수·행으로
`terminal.select`를 한 번 보낸다. 서버가 ref·현재 화면·치수를 다시 검사한다.
같은 감지 화면의 중복 제출은 거절한다. 복수 선택과 Other/직접 입력 항목은
`selectable: false`로 표시하고 기존 터미널 화면에서 답한다. 새 자유 입력 계약은 없다.
화면이 바뀌면 폰에 `화면이 바뀌었습니다, 새로 고침`을 표시한다.

65의 사람 차례 집합에 request ref로 포함하며 알림은 개수만 표시한다.
감지·해석 실패·오래된 선택 로그는 `[remote] prompt reason=<코드>`이며
화면 내용은 기록하지 않는다. 번호/›/❯ 시험 자료는 합성 자료이며 실제
Codex 질문·Claude 허용·계획 승인·폴더 신뢰 화면의 실기기 확인이 필요하다.


### packet 69: 질문 동시 표시와 해석 실패

`session.watch.prompts:true` 연결에는 보관 질문을 화면과 결합한 `terminal-prompt`로 전송한다. 구조화 질문 본문·설명·multiSelect는 유지한다. 단일 문항·단일 선택이며 화면 선택지와 label이 일치할 때만 선택 버튼을 제공한다. 선택은 기존 `terminal.select`의 pane·세션·화면 해시·크기·속도 검사를 거쳐 방향키와 Enter만 보낸다. 복수 선택·여러 문항·Other는 터미널 화면에서 답한다.

해석 실패는 `terminal-prompt`의 `{questions:[],screen:null}`로 전송한다. 보관 질문이 있으면 questions를 유지하고 screen만 null이다. 폰은 본문 없는 경우에도 `답 대기 · 터미널에서 답하기` 카드를 제공한다. caps에 `terminal.prompt-fallback`을 추가하고 `session.watch.promptFallback:true`로 screen:null을 구독한다. 이전 앱의 `prompts` 미지정 연결에는 terminal-prompt를 전송하지 않으며 promptFallback 미지정 연결에는 screen:null을 전송하지 않는다. 기기 등록과 PIN 검사는 동일하다.

질문 입력의 제어문자는 제거하고 기존 길이 상한을 유지한다. 상태 해제·해석된 질문 화면의 소멸·세션 종료·기한 만료로 카드를 제거한다. 로그에는 내용 없이 `[remote] question reason=computer-answered|session-ended|expired|replaced`와 `[remote] prompt reason=computer-answered|session-ended|unrecognized` 등의 사유를 기록한다.

### 브라우저 고속 화면과 휠

- `browser.frame.fast`: `browser.frame.watch`와 같은 필드·응답. `fps`는 1–20. caps에 이 요청이 있을 때만 사용하며 없으면 기존 `browser.frame.watch`와 1–4 fps를 사용한다. 변경 화면과 입력 직후에는 지정 fps로 조회하고 정지 화면은 2 fps로 조회한다. 동일 JPEG는 생략하며 입력 직후에는 동일 화면도 다시 보낸다. 캡처가 진행 중이면 추가 조회를 합쳐 다음 조회 한 번으로 처리한다.
- `browser.wheel`: `{type,rid,tab,x,y,width,height,dx,dy}`. 좌표 조건은 `browser.mouse`와 같고 두 델타는 각각 -20000–20000 정수이며 둘 다 0일 수 없다. CSS 뷰포트 좌표로 변환해 해당 위치에 가로·세로 CDP 휠을 전달한다. caps에 없으면 기존 세로 휠·직접 스크롤을 사용한다.
- `browser.frame.status`: `{type,tab,error}`. 고속 구독에만 전송한다. `error`는 `null` 또는 `browser-frame-unavailable`, `browser-tab-unavailable`, `browser-controller-unavailable`, `browser-command-unavailable`. 실패 후에도 조회를 재예약하며 프레임 복구 뒤 `null`로 해제한다. 폰은 사유를 표시하고 새 프레임이 오면 표시를 지운다.
- JPEG 원문 384 KiB와 프레임 JSON 520 KiB 상한, PIN·세션·송신 초당 9개·서버 입력 버킷을 유지한다. 휠은 폰에서 150ms 이상 간격으로 합치며 실행 중 하나와 합산 대기값만 유지한다. 클릭·키·글자 입력의 순서를 보존한다.
- 폰은 스크롤 중 현재 그림을 즉시 이동하고 새 프레임으로 교체할 때 이동량을 해제한다. 손을 떼면 속도를 초당 지수 감속하며 취소·화면 종료·탭 변경·오류 때 관성을 중지한다. 두 손가락의 간격 변화가 `max(6dp, 중심 이동 × 1.5)` 이상일 때 핀치로 확정하고 중심 이동이 6dp 이상이면 페이지 스크롤로 확정한다. 확대 상태의 직접 한 손가락 이동은 뷰 경계까지 이동하고 남은 이동을 페이지 휠로 보낸다.
- 프레임은 배율 1에서 위 정렬하고 주소줄·탭 줄 아래 영역 안에 종횡비를 유지해 맞춘다. 새로고침은 `browser.history` 지원 시 주소줄에 표시한다. 요청 동안 로딩을 표시하고 프레임 수신으로 종료하며 실패 사유를 표시한다.
- macOS 경로는 기존 CDP 세션에서 메모리 JPEG를 캡처하며 스크린샷 파일과 sips를 사용하지 않는다. Windows는 기존 PowerShell 변환을 유지한다. 캡처·변환·전송 준비 시간은 30회 평균으로 `[remote] browser-frame ms=<캡처>/<변환>/<전송>`에 기록한다. 전송 시간은 서버의 프레임 전달 함수 호출까지이며 폰 수신·디코딩 시간은 포함하지 않는다.

## 연결 키 (v2)

폰의 연결 키는 EC P-256 서명 키이며 안드로이드 키스토어(StrongBox 우선)와 iOS Secure Enclave 안에 있어 꺼낼 수 없다. v2 키는 서명할 때 폰 잠금 해제를 요구하지 않는다(이전 키는 최근 300초 안의 잠금 해제가 필요했다). 키 설정은 만든 뒤 바꿀 수 없어 이전 키는 지우고 새 키를 만들며, 컴퓨터에 등록한 공개키가 달라지므로 한 번 다시 페어링한다. 앱은 시작할 때 `hasKey`로 현재 버전 키가 있는지 확인하고 없으면 저장된 등록을 지우고 페어링 화면을 보여 준다. 폰 잠금(화면 잠금)이 설정되어 있지 않으면 키를 만들지 않는다.

## 폰에서 등록 해제

폰의 `이 폰 등록 해제`는 먼저 `{type:"device.unregister",rid}`를 보낸다. 서버는 이 연결을 인증한 기기 하나만 레지스트리에서 지우고(`remove-device`), 그 기기의 다른 세션과 재접속 토큰을 폐기하며, 요청한 연결에는 `remote.action.result`(`done` 또는 이미 없으면 `unchanged`)를 보낸 뒤 1초 안에 닫는다. 폰은 응답 뒤 연결 키와 저장값을 지운다. 연결이 없거나 서버가 실패하면 폰 쪽은 그대로 지우고 `Mac의 Iris 원격 화면에서 이 폰을 직접 삭제하세요` 안내를 시작 화면에 표시한다. 연결 끊기만으로는 등록이 남는다. v2 키 전환으로 폰이 이전 키를 잃은 기기는 서버에 이전 항목이 남으므로 Mac 원격 화면에서 직접 삭제한다.
