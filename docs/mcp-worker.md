# MCP 작업 프로세스 계약

이 문서는 공용 서버를 재시작하지 않고 MCP 처리 코드를 교체하기 위한 프로세스 경계와 통신 계약을
정한다. 이 계약의 기준은 `definition_revision: 3`이다. `design.md`의 G절이 앞 절과 다른 경우 G절을
적용한다.

## 프로세스 구성

| 프로세스 | 맡는 일 | 소유하는 상태 | 소유하지 않는 상태 |
| --- | --- | --- | --- |
| MCP 진입 프로세스 | `iris-mcp`·`iris-qa` stdio 계약, 세션 식별, HTTP 요청 | stdio 연결별 run key와 요청 순번 | 탭·기기·회차 파일·Electron 자원 |
| 공용 서버 | HTTP·WebSocket, worker 수명, host API, 탭·스페이스·사용자 대기 상태 | 브라우저 registry, 브라우저 저장 상태, `qa-ownership`의 `owners`, `qa-journal`의 Map, app-targets 쓰기, ask 대기열, 실행기 lease grant | QA 회차 처리, MCP 명령 분기, CDP 결과 가공 |
| MCP 작업 프로세스 | QA 회차 처리, 일반 브라우저 MCP 명령 분기·대상 선택 정책·다중 대상·대량 입력 정책, 옮긴 CDP 처리기 | 실행 중 회차의 계산 상태, 보고서 thread, 모바일 관찰, worker 내부 탭 큐 | 공용 서버 상태의 사본, Electron `webContents`, 비밀번호 원문 |
| Electron 메인 | 검증된 기본 명령 실행, 사람의 사용과 결합된 Electron 상태 | `webContents`, debugger·문서 세대, 부착 정책, 포커스·AI 인과, 업로드·다운로드·확인창 계획, 비밀값, 임시 자원 | QA 회차, MCP 세션의 전역 현재값, 명령 분기 정책 |
| 보고서 thread | 한 보고서의 생성 | thread 실행 중인 입력과 임시 결과 | 회차·탭·승인 상태 |

MCP 작업 프로세스는 HTTP 포트를 열지 않는다. 공용 서버가 `child_process.fork`로 만든 IPC 채널만
사용한다. 작업 프로세스가 종료되어도 공용 서버, 렌더러 WebSocket, Iris에서 실행한 개발 서버와
Electron 메인은 계속 실행된다.

공용 서버 상태를 worker로 복사하지 않는다. 조회 결과는 시점이 붙은 스냅샷이고, 그 결과를 근거로
상태를 바꿀 때는 아래 원자 연산을 다시 호출한다. 작업 프로세스는 `session`, `run`, `key`를 묶은
요청 단위로만 상태에 접근한다.

## 공통 메시지 형식

공용 서버와 worker 사이의 요청은 다음 필드를 갖는다.

```json
{
  "protocol": 1,
  "type": "host.request",
  "requestId": "0194dca0-4c26-7e3d-a501-f87f9476ce20",
  "workerGeneration": "81c9f850c2784f9f:7",
  "commandId": "81c9f850c2784f9f:7/184",
  "callId": 3,
  "operation": "browser.executeWithDialog",
  "identity": { "session": "w3:pS", "run": "run-1761990000000", "key": "..." },
  "input": {}
}
```

- `requestId`는 전송 한 번의 UUID다. 응답은 같은 값을 돌려준다.
- `workerGeneration`은 공용 서버 부팅 nonce와 그 부팅 안의 단조 증가 번호를 합친 불투명 문자열이다.
  같은지 여부만 비교한다. 공용 서버 재기동 뒤 숫자가 다시 시작되어도 이전 세대와 같아지지 않는다.
- `commandId`는 부수효과가 있는 상위 명령 하나에 하나다. 그 명령이 host API와 Electron 중계를 여러
  번 호출해도 같은 `commandId`를 쓰고 하위 호출 번호를 붙인다.
- lifecycle 명령은 `<workerGeneration>/lifecycle/<run>/<uuid>` 형식을 쓴다. 관찰 중단 과정에서는
  해당 worker 세대와 run의 Electron 작업 종료와 anchor 저장에만 이 권한을 쓴다.
- `callId`는 한 `commandId` 안에서 host API를 부른 순서다. 같은 하위 호출을 다시 전송할 때는 같은
  값을 쓰고 다음 호출에는 새 값을 쓴다.
- 조회 요청에는 `commandId`를 생략할 수 있다. 클릭·입력·탭 변경·파일 쓰기에는 반드시 넣는다.
- `identity`는 연산이 요구하는 식별값만 담는다. 없는 값을 공용 서버나 worker가 전역 상태에서 채우지
  않는다.
- 함수, Promise, callback, `Error`, `webContents` 객체를 메시지에 넣지 않는다.

성공 응답은 `{ protocol, type: "host.response", requestId, workerGeneration, ok: true, output }`이다.
실패 응답은 다음 형식이다.

```json
{
  "protocol": 1,
  "type": "host.response",
  "requestId": "...",
  "workerGeneration": "...",
  "ok": false,
  "error": {
    "code": "STALE_WORKER",
    "message": "현재 작업 프로세스 세대가 아닙니다.",
    "retryable": false,
    "details": {}
  }
}
```

MCP 진입 어댑터는 이 오류를 현재 도구 응답의 `{ ok: false, error: string }`로 바꿀 수 있다. IPC 안의
오류 코드는 유지한다. 오류 코드는 `INVALID_REQUEST`, `UNAUTHORIZED_WORKER`, `STALE_WORKER`,
`STALE_TARGET`, `SESSION_DENIED`, `RUN_DENIED`, `KEY_DENIED`, `QA_OWNED`, `NOT_FOUND`,
`DIALOG_BLOCKED`, `EXECUTOR_GONE`, `COMMAND_INDETERMINATE`, `BUSY`, `DRAINING`, `TIMEOUT`,
`DATA_INCOMPATIBLE`, `INTERNAL`을 기본 집합으로 쓴다.

같은 세대와 `commandId`·`callId`로 다시 온 부수효과 요청은 공용 서버가 보관한 완료 결과를 돌려준다. 실행
중이면 `BUSY`와 현재 상태를 반환한다. 세대가 다른 요청은 자동 재실행하지 않는다. 클릭·입력의 응답이
없어졌으면 `GET /mcp-worker/status`의 명령 상태를 확인한 뒤 사용자에게 결과 확인을 요구한다.

## host API의 원자성

공용 서버는 연산별 직렬화 키를 사용한다. 탭 연산은 `tab:<tabId>`, 세션 지정은
`session:<session>`, QA 소유권은 `qa:<tab-or-device>`, 기기 할당 파일은 `app-targets`, 사용자 질문은
`ask:<requestId>`, journal은 `run:<run>`을 쓴다. 한 연산의 검증, 메모리 변경, 파일 변경, broadcast는
그 키 안에서 순서대로 끝난다. 파일 전체를 바꾸는 연산은 임시 파일 쓰기와 rename을 사용한다.
직렬 실행기와 진행 중 작업 수는 worker 세대마다 새로 만들지 않고 공용 서버가 하나를 소유한다.
worker를 교체할 때 이전 세대에서 시작한 host API 호출이 모두 끝난 뒤 그 세대의 journal token,
파일 사용 표시, Electron 자원을 회수한다.

내부 조회 응답은 필요한 경우 `stateRevision`을 넣는다. MCP 도구의 기존 응답에 없던 필드는 추가하지
않는다. 상태에 따라 허용 여부가 달라지는 변경은 변경 연산 안에서 다시 검사한다. 여러 연산을
묶어야만 보존할 수 있는 조건은 별도 연산으로 만들지 않고 아래의 한 연산으로 처리한다.

### 브라우저·세션 연산

| 연산 | 입력 | 출력 | 오류 | 원자성 보장 |
| --- | --- | --- | --- | --- |
| `browser.sessionView` | 선택적 `session` | 기존 `tabs` 명령의 보이는 탭, 핸들, pin, grant, 그룹, profile 응답 | 없음 | 읽기 전용. 세션 없는 기존 호출도 허용 |
| `browser.targetGet` | 선택적 `session` | 기존 `target` 조회 응답 | 없음 | 읽기 전용. 세션 없는 기존 호출도 허용 |
| `browser.targetSet` | `session`, `tabRef` | 확정한 `tabId`·handle, pin 목록, 탭 메타 | `NOT_FOUND`, `SESSION_DENIED`, `QA_OWNED` | ref 해석, 권한 확인, pin·grant·그룹·last-tab 변경과 저장을 한 번에 처리 |
| `browser.targetClear` | `session`, 선택적 `tabRef` | 남은 pin·회수한 grant | `SESSION_DENIED` | pin·grant 회수와 저장을 한 번에 처리 |
| `browser.commandGuard` | 선택적 `session`, `tabRef` | QA 소유 여부 | 없음 | 명시 대상의 QA owner를 실행 전에 확인 |
| `browser.commandTargetState` | 선택적 `session`, 선택적 `tabRef`, `noAutoTab` | 실행 대상 또는 `wakeTab`·`grantedTab`·`needTab`·기존 오류 응답 | 없음 | `resolveTarget`의 부재 사유와 기존 오류 문구·data를 보존하고 ref·세션·QA 소유권을 함께 검사 |
| `browser.resolveForCommand` | `session`, 선택적 `tabRef`, 명령의 대상 요구 | `tabId`, `wcId`, handle, `documentGeneration`, `debuggerGeneration`, `targetToken` 또는 구조화된 부재 사유 | `NOT_FOUND`, `SESSION_DENIED`, `QA_OWNED`, `STALE_TARGET` | 현재 registry에서 ref·세션·소유권을 함께 검사. 일반 QA 명령은 현재 회차 소유를 요구하고, 종료 뒤 lifecycle 정리는 소유자가 없을 때만 허용한다. 다른 회차에 재할당된 탭은 거절한다. `targetToken`은 같은 문서 세대에만 유효 |
| `browser.tabCreate` | 선택적 `session`, URL, parallel, profile, 이유 | 만든 탭 또는 재사용 탭의 식별값 | `BUSY`, `NOT_FOUND` | 재사용 판정, 그룹 생성, 탭 생성, handle·pin·last-tab·grant 저장과 broadcast를 한 번에 처리. 세션 없는 기존 호출도 허용 |
| `browser.tabWake` | `session`, `tabId` | 새 `wcId`와 세대 | `STALE_TARGET`, `TIMEOUT`, `SESSION_DENIED` | 저장 상태의 동일 탭인지 재검사하고 한 번만 깨움 |
| `browser.tabClose` | `session`, `tabRef` | 닫은 handle과 남은 탭 | `SESSION_DENIED`, `QA_OWNED`, `NOT_FOUND` | 세션 그룹 소유 검사, 닫은 탭 기록, pin·grant 회수, 상태 삭제, broadcast를 한 번에 처리 |
| `browser.status` | 없음 | 실행기 연결, 현재 relay 세대, worker 상태 | 없음 | 읽기 전용 |
| `browser.promptTargetsActivate` | `session`, marker와 agent session 정보 | 활성화·거절 결과 | `INVALID_REQUEST`, `SESSION_DENIED`, `BUSY` | 그룹·탭·요소 grant·기기 할당을 한 요청의 계획으로 검증하고, app-targets 파일 변경은 직렬 처리 |
| `browser.pickRecord` | `session`, 종류, pick, 선택적 tabId | 저장한 pick id | `SESSION_DENIED` | 세션별 최근 10개 제한과 쓰기를 함께 처리 |
| `browser.pickList` | 선택적 `session`, 종류 | 브라우저 또는 앱 pick 목록 | 없음 | 읽기 전용. QA의 앱 pick은 pane을 확인하고 등록한 뒤 조회한다. 세션 없는 기존 호출도 허용 |

`targetToken`은 일반 MCP에 노출하지 않는다. worker가 Electron 중계를 요청할 때만 사용한다. Electron
메인은 토큰의 `wcId`, 문서 세대, debugger 세대, child session을 다시 검사한다.

### 실행·확인창 연산

| 연산 | 입력 | 출력 | 오류 | 원자성 보장 |
| --- | --- | --- | --- | --- |
| `browser.executeWithDialog` | identity, `tabId`, `targetToken`, relay 명령, args, timeout, answer tool | 가려진 명령 결과 또는 가려진 확인창과 `commandState` | `QA_OWNED`, `STALE_TARGET`, `DIALOG_BLOCKED`, `EXECUTOR_GONE`, `COMMAND_INDETERMINATE`, `TIMEOUT` | 탭·세션·QA 소유권 재검사, control 표시, 명령 등록, 확인창 경쟁, 실제 명령 종료 추적, 원문 기준 가리기를 host 안에서 처리. `dialog.full`은 IPC로 내보내지 않음 |
| `browser.dialogState` | identity, 대상 | 가려진 현재 확인창 또는 `null` | `STALE_TARGET`, `QA_OWNED` | 제어 활동을 표시하고 현재 확인창을 조회한다. 확인창 응답 명령이 열린 확인창 때문에 차단되지 않도록 실행 gate와 분리 |
| `browser.dialogAnswer` | identity, `tabId`, answer, 선택적 text | 가려진 확인창 정보와 처리 경로 | `STALE_TARGET`, `NOT_FOUND`, `EXECUTOR_GONE` | 제어 활동을 표시하고 가로챈 HTTP ask와 Electron dialog 중 현재 것을 한 번만 처리한 뒤 상태를 갱신 |
| `qa.anchorUpdate` | 요청한 `runId`, anchor 내용 | Electron이 확인한 anchor revision | `RUN_DENIED`, `EXECUTOR_GONE` | 요청한 회차 id를 `qa.anchor`에 전달한다. 보고서와 재검증 코드가 읽은 회차의 세션 일치를 검사 |

`browser.executeWithDialog`는 명령을 보내기 전에 열려 있던 확인창도 `dialogOpen`으로 반환한다.
확인창을 먼저 반환한 경우에도 원래 명령을 `commandId` 아래에서 계속
추적한다. 그 명령이 끝나기 전에는 drain 완료로 세지 않는다. 확인창 응답은 drain 중에도 허용한다.
worker 내부 재진입은 같은 `commandId`와 실행 권한을 전달해야 하며 새 탭 큐 항목을 만들지 않는다.
`dialog`, `dialogs`, `dialog.answer`, `dialog.plan`, `qa-mode`, `native*`, `handoff`, `redact`는 제한된 큐 우회로
분류한다. `current-server.js`의 dialog·redact·qa-mode 고정 host callback은 작업 프로세스 전환 ⑧ 전까지
기존 Electron 처리기를 계속 호출한다. 이 callback은 이번 단계에서 바꾸지 않는다.

### QA 탭·기기·사용자 연산

| 연산 | 입력 | 출력 | 오류 | 원자성 보장 |
| --- | --- | --- | --- | --- |
| `qa.claimIfFree` | `session`, `run`, `key`, tab 또는 `device:<id>` | 현재 owner와 claim 결과 | `KEY_DENIED`, `QA_OWNED`, `NOT_FOUND` | 비어 있는지 확인하고 같은 임계 구역에서 claim |
| `qa.releaseIfOwner` | `run`, 대상 | release 결과 | `RUN_DENIED`, `NOT_FOUND` | owner가 같은지 확인한 뒤 삭제 |
| `qa.owner` | 대상 | owner 또는 null | 없음 | 진단용 읽기. claim 결정에는 사용하지 않음 |
| `qa.tabCreate` | identity, URL | entry, tabId, handle, wc 세대 | `KEY_DENIED`, `BUSY`, `TIMEOUT` | 빈 탭 생성, 탐색 준비, QA claim, pane 기억, 상태 저장·broadcast를 한 번에 처리 |
| `qa.tabsRestore` | identity, 저장된 탭 목록 | 복원·소실·충돌 목록 | `KEY_DENIED`, `QA_OWNED`, `DATA_INCOMPATIBLE` | 현재 존재·소유권을 다시 대조하고 복원 가능한 탭 claim과 broadcast를 한 번에 처리 |
| `qa.tabClose` | identity, tabId | 닫힘 결과 | `RUN_DENIED`, `STALE_TARGET` | owner가 같은지 확인해 소유권을 해제한 뒤 탭 닫기, 복원 기록, 상태 삭제와 broadcast를 처리. QA 모드 해제 실패를 닫기 조건으로 삼지 않음 |
| `qa.tabsPublish` | `run` | browser-state revision | `RUN_DENIED` | 별도 변경 없이 현재 상태만 broadcast. 변경 연산은 자체 broadcast를 우선 사용 |
| `qa.deviceAuthorize` | identity, 선택 단계에서 정규화한 device id | owner, app-target revision | `KEY_DENIED`, `QA_OWNED` | 선택 단계에서 확인한 기기에 회차 소유권만 등록. 승인 단계에서 목록을 다시 조회하지 않고 app-targets도 바꾸지 않음 |
| `app.targetsGet` | 선택적 `session` | 그 세션의 기기 목록 또는 세션 없는 기존 응답 | 없음 | 세션이 있으면 그 세션 할당만 반환. 세션 없는 기존 호출도 허용 |
| `app.targetsSet` | `session`, device 목록, exclusive | 저장된 목록과 회수 대상 | `SESSION_DENIED`, `INVALID_REQUEST`, `BUSY` | 파일 전체 read-modify-rename과 emulator release/reown 계획을 직렬 처리 |
| `app.command` | identity, `list`·`viewport`·`open`·`picks` | emulator 응답 | `SESSION_DENIED`, `QA_OWNED`, `TIMEOUT` | 기기 할당·capacity·owner를 명령 직전에 재검사. 긴 실행은 기기별로 직렬화하고 세션 상태 변경만 세션 잠금 안에서 처리 |
| `qa.askUser` | identity, tab, message, choices, requestId | 답변 또는 pending 상태 | `KEY_DENIED`, `STALE_TARGET`, `TIMEOUT` | ask 대기열과 owner를 host가 소유. 같은 requestId에는 답 한 번만 배달 |
| `qa.reportOpen` | identity, URL | 연 탭 handle | `KEY_DENIED`, `SESSION_DENIED` | 세션 탭 생성과 보고서 URL 설정을 한 번에 처리 |

worker가 `qa.askUser` 대기 중 교체되면 공용 서버는 요청을 취소하지 않는다. 새 worker가 같은
`session`, `run`, 유효한 기존 `key`, `requestId`로 `qa.askUser`를 다시 부르면 pending 상태나 이미
도착한 답을 받는다. 그 결속을 확인할 수 없으면 `KEY_DENIED`로 끝내고 ask를 취소한다. 대기 중인 답을
다른 회차나 전역 최근 질문에 전달하지 않는다.

### journal·승인·사용자 알림 연산

| 연산 | 입력 | 출력 | 오류 | 원자성 보장 |
| --- | --- | --- | --- | --- |
| `journal.sessionCommand` | `session`, `run`, journal 명령과 args | 현재 명령 응답 | `RUN_DENIED`, `DATA_INCOMPATIBLE` | `traceBySession`, `runs`, `runBySession`, seq·calls·receipts를 한 owner에서 변경 |
| `journal.accept` | `session`, `run`, command, args | callId와 run token | `RUN_DENIED` | accepted 추가와 call 순번 증가를 한 번에 처리 |
| `journal.complete` | run token, 결과, tries | completed·assertion·artifact 결과 | `RUN_DENIED`, `DATA_INCOMPATIBLE` | accepted와 같은 run에 단조 seq로 기록하고 artifact 고정을 끝낸 뒤 응답 |
| `journal.release` | run token | release 결과 | `RUN_DENIED` | 명령과 출력 경로의 사용 표시를 해제. 결과 기록이 끝난 뒤 호출 |
| `journal.trace` | `session`, command, args, 결과 | 없음 | 없음 | 세션 trace 상한과 추가를 함께 처리 |
| `journal.recordFrame` | run token, tab, 시점, capture 요청 | frame 기록 | `RUN_DENIED`, `EXECUTOR_GONE` | usage lease, 촬영, 중복 판정, journal 기록을 한 작업으로 추적 |
| `journal.surfaces` | `session`, `run` | 대량 입력 정책용 surface 목록 | `RUN_DENIED` | 읽기 전용 |
| `lease.grant` | identity, 실행기와 범위, 만료 | lease id | `KEY_DENIED`, `SESSION_DENIED` | host 메모리에서 범위·만료·owner를 함께 기록 |
| `lease.check` | identity, lease id, 요구 범위 | 허용 범위 | `RUN_DENIED`, `NOT_FOUND` | 읽기와 만료 회수를 한 번에 처리 |
| `lease.revoke` | identity, lease id | revoke 결과 | `RUN_DENIED` | owner 확인 뒤 회수 |
| `user.ask` | `session`, tab, 메시지·선택지 | 답 또는 pending | `SESSION_DENIED`, `TIMEOUT` | `qa.askUser`와 같은 host 대기열 사용 |
| `user.notify` | `session`, 알림 | id와 표시 위치 | `SESSION_DENIED`, `INVALID_REQUEST` | 중복 key·10초 묶음·관련 탭 검증과 broadcast를 한 번에 처리 |
| `user.progress` | `session`, start·update·end | progress id와 상태 | `SESSION_DENIED`, `NOT_FOUND` | owner와 timer를 host가 함께 관리 |

`isActCmd`, `ordinaryCommandDenied`, `bulkPolicy`, `space-key` 계산, protocol schema는 상태 없는 공유
계약으로 둔다. `runFor`처럼 Map 안의 객체를 돌려주는 API는 IPC에 만들지 않는다. journal 연산이 run
token을 발급하고 이후 연산이 그 token을 사용한다. `qa-expiry-guard`는 파일 사용 표시를 관리하는
공유 서비스이며 배포 파일 목록에 포함한다. run token은 발급한 worker 세대를 기록한다. 공용 서버는
그 세대의 host 작업 종료를 확인한 뒤 남은 token과 파일 사용 표시를 회수한다.

## 현재 호출부와 host API 대응

아래 표는 두 파일에서 공용 서버가 소유할 상태에 접근하는 import와 공용 서버에 남을 export를 모두
대응시킨다. worker 소유 QA 모듈끼리의 호출과 `node:` 표준 라이브러리 호출은 host API 대상이 아니다.

### `qa-channel.js`

| 현재 호출 | 대응 연산 |
| --- | --- |
| `requestCdp`, `markControl`, `dialogBlocked`, `raceDialog`, `redactDialog`, `safeDialogResult` | `browser.executeWithDialog`; anchor는 `qa.anchorUpdate` |
| `wcOfTabId`, `tabMeta` | `browser.resolveForCommand`; 진단용 화면은 `browser.sessionView` |
| `answerDialogAsk`, `setTabDialog` | `browser.dialogAnswer`; dialog 상태 갱신은 연산 내부 |
| `createQaEntry` | `qa.tabCreate` |
| `restoreQaTabs` | `qa.tabsRestore` |
| `closeBrowserTab` | `qa.tabClose` |
| `publishQaTabs` | 변경 연산 내부 broadcast, 필요한 명시 호출은 `qa.tabsPublish` |
| `askQaUser` | `qa.askUser` |
| `openQaReport` | `qa.reportOpen` |
| `runQaAppCommand` | `app.command` |
| `qaOwner` | `qa.owner`; 변경 판단에는 `qa.claimIfFree`·`qa.deviceAuthorize` 사용 |
| `claimQaTab` | `qa.claimIfFree` |
| `releaseQaTab` | `qa.releaseIfOwner` 또는 `qa.tabClose` |
| `artifactDir`, `stateHome` | 상태 없는 공유 경로 함수. 요청의 상태 폴더를 바꾸지 않으며 공용 서버 상태 객체를 반환하지 않음 |

### `browser-commands.js`

| 현재 호출·상수 | 대응 연산 또는 공유 계약 |
| --- | --- |
| `MAX_PINS` | `browser.sessionView.maxPins`의 protocol 상수 |
| `pinsOf`, `primaryPin`, `addPin`, `dropPin`, `persistGrants`, `grantTab`, `revokeTab`, `grantTabIdsOf`, `grantedByTabId` | `browser.sessionView`, `browser.targetSet`, `browser.targetClear`, `browser.promptTargetsActivate` |
| `sessionSpace`, `sessionLabel`, `sessionGroupId`, `sessionGroupName`, `groupExists`, `groupTabIds`, `groupHandleFor`, `ensureSessionGroup`, `absorbIntoSessionGroup`, `getLastTab`, `setLastTab` | `browser.sessionView`, `browser.resolveForCommand`, `browser.tabCreate`, `browser.targetSet` |
| `rememberQaPane` | `qa.tabCreate`, `qa.tabsRestore` 내부의 session·space 결속 |
| `tabIdOfRef`, `handleFor`, `tabMeta`, `wcOfTabId`, `hasTab`, `tabExistsInState`, `tabAllowed`, `visibleTabsFor`, `resolveTarget`, `goneReply` | `browser.sessionView`, `browser.resolveForCommand` |
| `wakeSleepingTab`, `waitForTabWc` | `browser.tabWake` |
| `profileNames`, `profileRefToId`, `hasProfiles` | `browser.sessionView`, `browser.tabCreate` |
| `recordClosedTab`, `removeClosedTab`, `closedTabsWire`, `controlOwnerOf`, `storageSpaceOfTab`, `bsMutate`, `bsWire` | `browser.tabClose`; 상태 wire는 연산 내부 broadcast |
| `replaceDesignatedGroups`, `replaceDesignatedTabs`, `broadcastAiTargets`, `activatePromptTargets`, `reportAgentSessionPath`, `MAX_PROMPT_TARGET_MARKERS` | `browser.promptTargetsActivate`; marker 상한은 protocol 상수 |
| `cdpExecutorReady` | `browser.status` |
| `requestCdp`, `markControl`, `answerDialogAsk`, `dialogBlocked`, `raceDialog`, `safeDialogResult`, `redactDialog` | `browser.executeWithDialog`, `browser.dialogAnswer`, `qa.anchorUpdate` |
| `qaOwner`, `claimQaTab` | `qa.owner`, `qa.claimIfFree`; 기기는 `qa.deviceAuthorize` |
| `ordinaryCommandDenied`, `isActCmd`, `bulkPolicy`, `spaceKey` | 상태 없는 공유 계약 |
| `handleQaSessionCmd`, `noteRunAccepted`, `noteRunEvent`, `recordFrame`, `runFor`, `noteTrace`, `runSurfaces` | `journal.sessionCommand`, `journal.accept`, `journal.complete`, `journal.recordFrame`, run token, `journal.trace`, `journal.surfaces` |
| `appTargetsFor`, `readAppTargets`, `setAppTargets`, `MAX_APP_TARGETS` | `app.targetsGet`, `app.targetsSet`, `browser.promptTargetsActivate`; 상한은 protocol 상수 |
| `emulatorCapacity`, `askEmulator` | `app.command` |
| `HerdrClient`, `broadcast`, ask·notify·progress Map과 timer | `user.ask`, `user.notify`, `user.progress` |
| `pickLog`, `appPickLog`, `noteBrowserPick`, `noteAppPick` | `browser.pickRecord`, `browser.pickList` |
| `qaExpiry` | 공유 `qa-expiry-guard` 서비스. worker 배포 manifest에 포함 |

`browser-commands.js`가 현재 내보내는 함수의 배치는 다음과 같다.

| 현재 export | 배치 |
| --- | --- |
| `runBrowserCmd` | 공용 서버에 남은 탭 생성·닫기와 app 상태 연산. CDP 실행 분기는 없음 |
| `runSessionCmd` | 공용 서버 상태 연산. worker는 대응 host 연산으로만 호출 |
| `initBrowserCommands`, `setUserInterfaceFocus`, `answerUserAsk`, `pendingUserNotices`, `consoleAsk` | 공용 서버의 사용자 대기·broadcast owner |
| `noteBrowserPick`, `noteAppPick` | 공용 서버의 `browser.pickRecord` |
| `closeBrowserTab` | 일반 명령은 `browser.tabClose`, QA identity가 있는 명령은 `qa.tabClose` |
| `createQaEntry`, `restoreQaTabs`, `askQaUser`, `openQaReport`, `runQaAppCommand`, `publishQaTabs`, `execOnWc` | 각각 `qa.tabCreate`, `qa.tabsRestore`, `qa.askUser`, `qa.reportOpen`, `app.command`, `qa.tabsPublish`, `browser.executeWithDialog` |
| `prepareQaEntryNavigation` | worker의 상태 없는 순서 제어. 실제 탭과 relay는 주입받은 host 연산 사용 |
| `splitQaRestoreTabs` | 상태 없는 공유 함수. owner·exists 판정값은 host 연산의 같은 revision 결과만 사용 |

이 대응표의 연산은 기존 accessor를 그대로 원격 호출하라는 뜻이 아니다. 같은 행의 여러 accessor가
한 상태 변경의 조건이면 대응 연산 하나가 다시 검사하고 변경한다.

## worker IPC 수명

### 기동

1. 공용 서버가 256비트 일회용 토큰과 새 `workerGeneration`을 만들고 IPC 채널을 포함해 worker를
   실행한다. 토큰은 로그, argv, manifest, `current.json`에 쓰지 않는다.
2. worker는 5초 안에 `worker.hello { protocol, deployId, pid, token }`을 보낸다.
3. 공용 서버는 자신이 만든 child pid, IPC 채널, 아직 소비되지 않은 토큰, manifest의 protocol과
   deploy id를 모두 확인한다. 토큰은 한 번 확인한 뒤 폐기한다.
4. 공용 서버가 `worker.authorized`를 보내야 worker가 실행 잠금을 요청할 수 있다. 직접 실행한
   프로세스는 이 메시지를 받을 수 없으므로 잠금이 비어 있어도 접수하지 못한다.
5. worker가 파일·데이터 호환성을 확인하고 `worker.ready`를 보낸다. 공용 서버가
   `worker.accept { workerGeneration }`를 보낸 뒤에만 요청을 받는다.

부모 IPC가 끊기면 worker는 즉시 새 요청을 거절하고 drain을 시작한다. 독립 서버로 전환하거나 다른
공용 서버에 재접속하지 않는다.

### 접수 중지와 종료

공용 서버는 다음 신호를 순서대로 사용한다.

- `worker.stopAccepting`: 새 MCP·QA 요청을 `DRAINING`으로 거절한다. 확인창 응답과 status는 허용한다.
- `worker.drain`: 접수한 명령, 탭 큐, 모바일 실행, 보고서 thread, journal 쓰기, anchor 갱신, Electron
  실행을 완료한다. 활성 관찰이 있으면 `BUSY`와 관찰 목록을 반환하고 교체를 거부한다.
- `worker.stopObservations`: 사용자가 `--stop-observations`를 지정한 경우만 관찰 결과를 저장하고 중단
  사실을 journal에 기록한다.
- `worker.shutdown`: drain 완료 뒤 자원 해제와 잠금 반환을 요청한다.
- `worker.stopped`: worker가 더 실행하지 않으며 잠금을 반환했다는 최종 확인이다.

기본 drain 상한은 30초, 종료 상한은 5초다. drain 상한을 넘으면 새 worker를 시작하지 않고 이전
worker의 접수를 재개한다. retire 뒤 종료 상한을 넘으면 아래 복구 절차에 따라 이전 worker를 종료하고
새 세대를 실행한다. Electron에서 실행 여부가 불명확한 명령이 있으면 `COMMAND_INDETERMINATE`를
반환하고 자동 재실행하지 않는다.

모바일 `retainIdle` watcher도 활성 관찰 목록에 들어간다. 관찰을 저장하고 중단하면 목록과 구독에서
함께 제거한다. 관찰 중단과 두 번째 drain처럼 Electron retire 전 단계가 실패하면 살아 있는 이전
worker의 접수를 다시 연다. 이전 worker가 죽었으면 공용 서버의 현재 worker 참조를 지우고 같은 배포를
다시 실행한다.

worker 잠금은 pid와 그 프로세스의 시작 시각을 함께 기록한다. pid가 같아도 시작 시각이 다르면 이전
소유자가 죽은 것으로 판정한다. 잠금 대기 상한을 넘으면 기동을 실패로 끝낸다. worker가 `SIGTERM`을
받으면 접수를 중지하고 활성 작업이 끝날 때까지 기다린 뒤 잠금을 반환한다.

시작 시각은 잠금 소유자가 바뀔 때 한 번만 읽는다. 같은 소유자를 기다리는 동안에는 pid 생존 여부를
확인한다. pid가 살아 있으면 시작 시각을 읽지 못해도 잠금을 회수하지 않는다. 감독기가 만든 자식
worker는 자식 handle의 종료 이벤트와 세대가 일치할 때 잠금을 회수할 수 있다. worker는 잠금의 lease
소유자가 바뀌면 새 요청 접수를 중지한다.

비정상 종료 복구는 아래 takeover 절차를 사용한다. accept 직후 child가 종료한 경우도 현재 worker로
등록하지 않고 같은 절차를 다시 실행한다. 개발 소스 다시 불러오기가 새 worker 기동에 실패하면 이전
소스를 새 세대로 복구한다. 실행기 재등록 accept가 실패하면 같은 현재 세대의 accept를 다음 실행기
재등록 또는 다음 MCP 요청에서 다시 보낸다.

### 강제 복구

`POST /mcp-worker/activate`에 `recover: true`를 보내면 현재 상태와 관계없이 강제 복구한다. 로컬 요청
제한과 인증 조건은 일반 activate와 같다. 진행 중인 자동 복구가 있으면 상한 안에서 결과를 기다리고
새 worker가 `accepting`이면 그 결과를 반환한다. 남은 복구는 다음 순서를 따른다.

1. 감독기가 자신이 만든 자식 worker에 `SIGTERM`을 보내고 5초 안에 종료하지 않으면 같은 child
   handle에 `SIGKILL`을 보낸다. 종료 확인에도 5초 상한을 적용한다.
2. pid가 죽은 worker 잠금을 세대와 child handle을 확인한 뒤 회수한다.
3. 이전 세대를 종료 상태로 표시해 아직 직렬 실행을 기다리는 host 호출을 `STALE_WORKER`로 거절한다.
   실행 중인 host 작업은 상한 안에서 기다린 뒤 run token과 파일 사용 표시를 반환한다. 상한 뒤 끝난
   작업이 token이나 사용 표시를 만들면 그 작업이 끝날 때 같은 세대의 자원을 다시 반환한다.
4. 새 worker를 실행한다.
5. 새 세대 accept에 `takeover: true`를 넣는다.
6. 새 worker가 `accepting`이 된 뒤 `current.json`을 기록한다. 기록에 실패하면 새 worker를 current로
   유지하고 `POINTER_WRITE_FAILED`를 반환한다.

셸의 `kill`·`pkill` 명령은 사용하지 않는다. 감독기는 이전 세대의 자식 종료와 takeover accept가
확인될 때까지 그 세대를 복구 대기 상태에 보존한다. 어느 단계가 실패해도 다음 recover는 같은 순서를
처음부터 다시 실행한다.

`deployId`가 있으면 그 배포를 사용한다. 없으면 검증된 `current.json` 배포를 사용하고 검증에 실패하면
설치 bundle worker를 사용한다. start 실패, draining, retiring, failed, current 없음, 재시작 상한 초과
상태에서도 한 번의 recover 요청으로 새 세대를 접수해야 한다. 진행 중 명령의 결과가 불명확하면 자동
재실행하지 않는다.

일반 retire가 시작된 뒤 실패하면 이전 세대를 다시 accept하지 않는다. 감독기는 이전 세대와 이전
배포를 복구 대기 상태로 보존하고 다음 MCP 요청이나 실행기 재등록에서 takeover 복구를 실행한다. 새
current가 접수되면 이전 복구 대기를 지운다. 재시작 상한을 넘은 경우에는 `retryAt` 뒤 다음 요청이나
실행기 재등록이 죽은 세대의 host 자원을 반환하고 같은 takeover 절차로 지정 배포를 다시 기동한다.
이전 relay 세대의 회수 재시도가 `STALE_WORKER`를 반환하고 현재 worker가 다른 세대로 접수돼 있으면
그 회수 항목을 지운다. 이 결과로 현재 worker를 `failed`로 바꾸지 않는다.

### relay 이벤트 IPC

공용 서버는 `cdp.subscribe` host 요청을 처리하는 동안 구독 ID를 현재 worker 세대에 등록한다. 구독
응답보다 이벤트가 먼저 도착해도 등록된 ID의 첫 이벤트를 잃지 않는다. Electron에서 받은 이벤트의
`workerGeneration`, `subscriptionId`, 단조 증가 `eventSeq`가 현재 등록과 모두 맞을 때만
`relay.event` IPC로 현재 worker에 보낸다. 알 수 없는 구독, 중복·역순 번호, 이전 worker 세대의
이벤트는 버린다. `EVENT_OVERFLOW` 이벤트를 보낸 뒤에는 그 구독을 제거한다. worker의 host API
client는 `onRelayEvent`로 이벤트를 구독하며 host 응답과 같은 pending 요청으로 취급하지 않는다.

### 상태 조회

`GET /mcp-worker/status`는 루프백에서만 읽을 수 있고 다음 값을 반환한다.

```json
{
  "deployId": "...",
  "pid": 1234,
  "workerGeneration": "81c9f850c2784f9f:7",
  "state": "accepting",
  "accepting": true,
  "startedAt": "2026-11-01T08:00:00.000Z",
  "active": {
    "commands": [], "observations": [], "mobile": [], "reports": [],
    "journalWrites": [], "relayCommands": []
  },
  "lastActivation": { "deployId": "...", "result": "ok" }
}
```

상태는 `absent`, `starting`, `ready`, `accepting`, `draining`, `stopping`, `failed` 중 하나다. 활성화 응답을
잃은 배포 명령은 이 응답에서 deploy id와 상태를 확인한다. 같은 deploy id가 이미 `accepting`이면
활성화 재요청은 성공으로 응답한다.

기존 `GET /healthz` 응답에는 `appPath`, Electron 메인 pid, 위 상태 응답의 `deployId`, `pid`,
`workerGeneration`, `state`, `accepting`을 추가한다. `/healthz`는 worker 상세 활성 목록이나 토큰을
반환하지 않는다. 상세 활성 목록은 루프백의 `/mcp-worker/status`에서만 읽는다.

## Electron 중계 계약

공용 서버는 worker 요청을 현재 공용 서버와 연결된 Electron 메인으로 전달한다. 모든 요청은
`workerGeneration`, `commandId`, 하위 호출 번호, 명령 이름, target token을 갖는다.

### 기본 명령

- CDP: `cdp.send`, `cdp.batch`, `cdp.frames`, `cdp.reset`, `cdp.subscribe`, `cdp.unsubscribe`, `ax.tree`
- webContents: `wc.info`, `wc.nav`, `wc.exec`, `wc.input`, `wc.capture`, `wc.captureToFile`, `wc.pdf`,
  `wc.pdfToFile`
- 메인 소유 기능: `tab.state`, `hold.capture`, `focus.state`, `focus.prepare`, `focus.return`, `ai.enter`, `ai.leave`,
  `viewport.get`, `viewport.apply`, `viewport.setTemporary`, `viewport.restore`, `viewport.ensureReady`,
  `viewport.qa`, `obs.read`, `obs.drain`, `obs.clear`, `ref.resolve`, `cdp.detachIdle`, `result.redact`, `cdp.gate`, `cdp.sync`, `wc.navHistory`,
  `cdp.screencastShot`, `img.stitch`, `img.diff`, `img.same`, `dialog.state`, `dialog.answer`, `dialog.plan`,
  `upload.arm`, `download.state`, `download.configure`, `login.accounts`, `login.fill`, `login.input`,
  `native.click`, `native.key`, `native.drag`, `native.window`, `native.windowClick`, `native.windowKey`,
  `qa.mode`, `qa.anchor`, `img.render`, `contextaction`, `obs.pending`, `obs.since`

`pick-mode`, `sketch-shot`, capability ctx의 요소 위치 조회와 `capturePage`는 Electron 메인 안의 작은
처리로 남긴다. worker 교체 여부와 관계없이 동작한다.

### host 작업 위임

공용 서버의 dialog·redact·QA mode·journal screenshot 호출은 현재 worker에 host 작업으로 맡긴다.
공용 서버는 supervisor의 기존 IPC로 작업을 보낸다. 조각 6a 부터 worker 는 `dialog`·`redact`·`qa-mode`를
처리기가 있고 메인이 그 기능을 알리면 기본 명령 단위로 실행한다(`host-task-service.js`).

- `dialog`: 네이티브 처리기의 `dialog` 본문(`dialog.answer`). 대기열 밖 단위.
- `redact`: `result.redact` 한 번. 옛 응답 모양(`{ ok, data: { ok, text } }`)으로 돌려주고 대기열 밖 단위.
- `qa-mode`: QA 처리기의 `qa-mode`(켜기는 대기열 안, 해제는 단위 이름 `qa-mode-off`).
- `screenshot`: 일반 `screenshot` 처리기(`page-route.js`)를 탭 대기열 안 단위로 실행한다(조각 6b). 옛 host 작업도 `requestCdp` 로 `cdpQueues` 에 섰기 때문에 `outside` 가 아니다.
  `page` 기능(`worker-page-commands`)이 없으면 옛 `legacyHostTask`.

처리기가 없거나 경로 표가 `legacy` 이거나 기능 알림이 없으면 옛 명령을 `browser.legacyHostTask` 로 보낸다.
호스트 확인 창이 열려 있어도 `dialog`·`redact`·`qa-mode-off` 단위는 확인 창 게이트를 통과한다
(단위 이름으로 판정, `qa-mode` 켜기는 계속 막힘). 하위 호출의 `commandId` 는 요청마다 새 값
(`<요청 commandId>/host/<uuid>`)이라 같은 요청 안의 반복 작업이 host 의 commandId·callId·입력 중복 방지에 걸리지 않는다.

worker가 없거나 요청을 받지 않는 상태이거나 기존 명령의 응답 상한 안에 끝나지 않으면 공용 서버가
같은 옛 Electron 명령을 직접 보내 기존 동작을 유지한다. host 작업 위임 요청은 host keyed serial
lock 밖에서 worker 응답을 기다린다. worker가 위임받은 작업을 처리하며 다시 부르는 host API도 같은
lock을 기다리지 않는다.

Electron은 worker 메타가 없는 옛 봉투와 worker가 보낸 옛 명령 봉투를 모두 기존 처리기로 실행한다.
`workerGeneration`·`commandId`·`callId`·target token이 붙었더라도 명령 이름이 기본 명령 집합에 없으면
기존 처리기로 보낸다. 이 분기는 ⑦에서 worker 구현을 기본 명령으로 바꿀 때까지 유지한다.

### 명령 단위 실행

worker 명령 하나(commandId)가 보내는 기본 명령은 메인에서 옛 처리기 명령과 같은 탭별 `cdpQueues` 안의
한 단위로 실행한다. 앞서 대기 중인 명령 뒤에 서고, 단위가 끝나기 전에는 다른 명령이 끼지 않는다.
결과는 옛 처리기와 같은 `redactSecrets` 를 거치고, 마지막 호출의 응답에 관찰 순간(`moments`)을 비워
붙인다(QA 탭은 `qa-observe` 만). 시간 초과(25초)는 옛 경로처럼 그 탭의 CDP 세션을 끊고 대기열을 푼다.

- 봉투: 중계 요청의 `relay.unit = { command, phase }`. `command` 는 사용자 명령 이름, `phase` 는
  `run`(중간) · `last`(마지막 호출, 단위를 닫고 moments 비움) · `end`(응답 없이 단위만 닫음).
  처리기는 마지막 `base()` 호출에 `{ last: true }` 를 단다. 마지막 호출이 끝나지 못하면(확인 창 차단 등)
  worker 가 `end` 를 보내고, 확인 창이 떠 있어도 통과한다.
- 풀리는 조건: 마지막 호출 · `end` · 시간 초과 · worker 세대 retire/교체/재연결(`acceptGeneration` 포함) · 탭 닫힘.
  실패로 닫힌 단위의 이후 호출은 새 단위를 열지 않고 같은 오류를 받는다.
- 기능 알림: 메인이 executor 등록 메시지에 `features: ["worker-command-unit", "worker-input-commands", "worker-page-commands", "worker-native-commands", "worker-qa-input-commands", "worker-qa-observe-commands", "worker-ax-tree"]` 를 싣고, 공용 서버가
  `browser.status` 의 `executor.features` 로 노출한다. worker 는 명령마다 이 값을 보고 없거나 조회에
  실패하면 옛 봉투(legacy)로 보낸다. 명령이 요구하는 기능은 `command-routes.js` 의 `requiredFeatures` 가 정한다
  (url·snapshot 은 `worker-command-unit` (snapshot 의 `worker-ax-tree` 는 필수가 아니라 있으면 쓰는 기능), 입력 명령은 + `worker-input-commands`, 페이지·읽기·캡처 명령은 + `worker-page-commands`, 네이티브 명령은 + `worker-native-commands`, QA 입력·로그인·화면 크기·QA 모드 명령은 + `worker-qa-input-commands`, QA 확인·캡처·관찰·반응 명령은 + `worker-qa-input-commands` + `worker-qa-observe-commands`). 기능이 없는 메인(이전 설치 앱)과 새 worker 의 조합이 eb90977 과 같다.
- 단위가 닫힐 때 자원 반환: 단위 안에서 얻고 돌려주지 못한 AI 표식(`ai.enter`)과 capture hold(`hold.capture`),
  worker 가 임시 layout 으로 표시한 덮어쓰기(`cdp.send` args 의 `temporaryLayout: true`, `Emulation.set/clearDeviceMetricsOverride`, 세션 대상 제외; 크기와 무관)는
  실행 중이던 호출이 끝난 뒤(상한 3초) 메인이 반환한다(`releaseCommand`). 반환 시점은 마지막 호출·`end`·시간 초과·탭 닫힘·세대 회수이고
  세대 회수는 retire 정리에서 같은 반환을 한다. 덮어쓰기는 명령이 직접 지웠으면 추적에서 빠지고, 사람이 정한 viewport(기기 emulation 포함)가
  있으면 지우지 않고 그 값으로 다시 건다. 이후 캡처·페이지 조각의 임시 `Emulation.*` 도 같은 반환을 쓰며, 표시가 없는 `Emulation.*` 호출은 반환 대상이 아니다. 옛 `withLayout`(`cdp-layout.cjs`)은 `innerWidth` 가 0 일 때만 덮어쓰고 finally 에서 `clearDeviceMetricsOverride` 를 보낸다. 기기 emulation 이 걸린 탭은 `innerWidth` 가 0 이 아니라 덮어쓰지 않으며(worker 사본도 같은 텍스트), 덮어쓴 채 사람 viewport 가 있으면 옛 finally 와 달리 그 값으로 다시 건다.
- 최종 응답 가리기: worker 는 비밀 원문이 없으므로 입력·페이지 처리기의 최종 응답(오류 응답 포함)을 기본 명령 `result.redact { value }` 에 실어
  메인의 `redactSecrets`(같은 탭 키)를 한 번 거친 값으로 받아 돌려준다. 성공이면 이 호출이 `last`(관찰 순간도 여기서 붙음)이고,
  실패면 `last` 없이 보낸 뒤 `unit.end` 로 닫는다. 가리지 못하면 응답을 내지 않고 오류를 돌려준다. 확인 창이 막은 명령은 닫힌 문 뒤라
  worker 가 반환 호출을 보낼 수 없고, 옛 처리기는 명령이 끝날 때 finally 로 반환했기 때문이다.
- 탭 잠금: 단위 호출(`relay.unit`)은 host 가 `tab:` 잠금을 호출마다 잡지 않는다. 단위의 첫 호출이
  `browser.executeWithDialog` 안에서 그 탭 잠금을 얻어 `last` · `end` · 유휴 만료(마지막 호출 뒤 35초)까지
  쥐고, 같은 commandId 의 호출은 잠금 없이 실행한다. 다른 명령은 그 잠금 뒤에 선다. 그래서 호출 사이에
  끼어든 옛 명령이 잠금을 잡고 단위를 기다리는 교착이 없다. 이미 끝난 단위의 `end` 는 잠금 없이 전달만 한다.
- 끊긴 세션: 단위 안의 `cdp.send` · `cdp.batch` · `cdp.frames` · `ax.tree` 가 옛 `DEAD_SESSION_RE` 오류를 받으면 옛
  `execWithReattachRaw` 와 같은 조건(`cdp_blocked` 제외)으로 세션을 다시 붙이고 새 세대 token 으로 한 번 재시도한다.
  탭이 없으면 `tab_gone`, 재시도도 끊겼으면 `session_detached`. 재붙임 뒤 worker 의 다음 호출은 `cdp.attach` 응답이
  아닌 이상 옛 token 을 쓰므로, 세대를 올릴 수 있는 처리기는 `cdp.attach` 를 먼저 부른다.
- 대기열 밖 단위: `relay.unit = { command, phase, outside: true }` 는 탭 대기열에 서지 않고 호출마다 바로 실행한다(옛 `QUEUE_BYPASS`).
  같은 시간 제한(25초, 시간 초과는 CDP 세션을 끊지 않음)·`redactSecrets`·끊긴 세션 재붙임을 거치고, `last` 응답에만 관찰 순간을 붙인다.
  `last`·`end` 때 그 명령이 얻고 돌려주지 못한 AI 표식·hold 를 반환한다(`onClose`). host 는 이 단위에 탭 잠금 보유(`executeUnitCall`)도 호출별
  `tab:` 잠금도 쓰지 않는다(옛 eb90977 은 탭 잠금 없이 Electron 에서 바로 실행). 확인 창을 푸는 명령이 막힌 명령 뒤에 갇히지 않게 하는 표시다.
- 확인 창 게이트: host 는 확인 창(JS)이 떠 있으면 `dialog`·`dialogs` 만 통과시키고(옛 `browser-commands.js` 와 같음) 나머지는 `dialogOpen` 으로 막는다.
  `dialogs` 처리기는 기본 명령을 여럿 부르므로 단위의 사용자 명령 이름(`unit.command`)이 `dialog`·`dialogs` 인 호출 전부를 통과시킨다.
  단위 명시 종료(`phase: end`)는 언제나 통과한다. `dialoginfo`·`nativewin`·`nativekey`·`nativeclick` 은 Electron 대기열 밖에서 실행되지만 확인 창이
  떠 있으면 host 에서 막힌다(옛 경로와 같음).
- 배선: 단위 분기 · 세대 수락/회수 해제 · 탭 닫힘 감시는 `native/electron/relay/unit-wiring.cjs` 에 있고
  `test/electron-unit-wiring.mjs` 가 대역으로 실행한다.

### 새 기본 명령 (snapshot 이전)

- `cdp.attach { command }`: 옛 `cdpExecRaw` 앞 단계(`attachPolicy.touch` + `ensureAttached`, 로그인 호스트면 같은
  `cdp_blocked` 오류)를 하고 `{ documentGeneration, debuggerGeneration }` 을 돌려준다. 붙이며 세대가 오르면 worker 는
  이 응답으로 이후 호출의 target token 을 바꾼다(`refreshedToken`).
- `ref.record { refs: [[ref, { backendDOMNodeId, role, name, sid, nth }]...] }`: worker 가 만든 ref 목록을 메인
  `cdp-ref-registry` 에 기록한다(2만 개 이하, 항목 형식 검사). 옛 click·fill 이 계속 메인 registry 를 읽으므로 ref
  상태는 메인에 남기고 쓰기만 이 명령으로 한다.

`snapshot` 은 `COMMAND_ROUTES.snapshot = "worker"`. 순서는 `cdp.attach` → `viewport.ensureReady` → `cdp.frames` →
AX 트리(`ax.tree`, 프레임은 `sessionId`)·cursor 조회(`cdp.send`) → `ref.record` → `wc.info` → `loginHint` → `humanHint`(마지막, `last`).
엔진과 힌트는 `server/mcp-worker/snapshot-engine.js` · `page-hints.js` 의 사본이며 원본(`native/electron/`)은 ⑧에서 지운다.
사본 동일성은 `test/mcp-worker-snapshot-route.mjs` 가 파일 내용과 결과로 대조한다.
옛 처리기 응답 기록은 `test/fixtures/worker-route-snapshot-golden.json`.

### snapshot cursor 요소 해석 묶기

엔진의 `findCursorInteractiveElements` 가 요소(최대 50개)마다 `Runtime.evaluate` → `DOM.describeNode` 를 순차로 보내 snapshot 1회가
CDP 104번(worker 경로에서는 worker → 공용 서버 → 메인 왕복 104번)이었다. worker 엔진은 이를 `Runtime.evaluate`(배열) →
`Runtime.getProperties`(원소 objectId) → `cdp.batch`(`DOM.describeNode` 전부) 로 줄여 7번으로 보낸다(위키백과 Electron 문서, 헤드리스 계수).
메인은 바꾸지 않고 기존 `cdp.batch` 를 쓴다(`BASE_COMMANDS` 에 중계 도입 커밋 4a116d5 부터 있음).

- `snapshotHandler` 가 최상위 sender 에만 `send.batch(commands)` 를 붙인다. 엔진은 `sendCommand.batch` 가 있을 때만 묶고, iframe sender·`inspect-commands.js`
  의 sender 에는 없어 옛 순차 경로로 간다. cursor 탐색은 최상위 sender 로만 부른다.
- `cdp.batch` 는 하나라도 실패하면 전체가 실패한다. 실패하면 이미 받은 objectId 로 `DOM.describeNode` 를 하나씩 보내 요소 하나의 실패만 건너뛴다(옛 결과와 같음).
  `getProperties` 등 앞 단계가 실패하면 처음부터 옛 순차 경로로 대체한다. 확인 창 차단(`commandState` 가 `completed` 아님)은 다른 호출처럼 처리기를 멈춘다.
- 이 때문에 worker 엔진 사본은 메인 사본과 같지 않다: 요소 해석 부분과 `resolveBackendIds`·`resolveBatched` 만 다르다. 사본 대조 시험은 그 범위를 빼고 글자로 대조하고,
  그 범위는 `test/mcp-worker-snapshot-batch.mjs`(실제 Chromium 페이지에서 옛 엔진과 buildSnapshot 출력 대조, 묶음 실패 대체, 왕복 수)가 결과로 대조한다. 메인 사본은 ⑧에서 지운다.

### 새 기본 명령 (snapshot 접근성 트리 축소)

`ax.tree { sessionId? }` → `{ nodes }`. 메인이 `Accessibility.getFullAXTree` 를 `cdp.send` 와 같은 규칙(자식 세션 소유 확인,
비밀 가리기, 로그인 호스트 거부, 끊긴 세션 재붙임, 탭 대기열·시간 초과)으로 실행하고 엔진이 읽는 노드 필드만 남겨 돌려준다
(`native/electron/ax-prune.cjs`: `nodeId` `childIds` `ignored` `role.value` `name.value` `backendDOMNodeId` `focusable` 속성 하나).
큰 페이지에서 전달 크기를 줄이려는 명령이며 엔진(트리 → 텍스트)은 worker 에 남는다.
메인 기능 이름 `worker-ax-tree`. snapshot 처리기는 이 기능을 알린 메인이면 인자 없는 `Accessibility.getFullAXTree` 를 `ax.tree` 로 보내고,
알리지 않는 메인(이전 설치 앱)이면 지금처럼 `cdp.send` 로 전체 트리를 받는다. 일반 MCP 요청에서는 내부 명령이라 부를 수 없다.
엔진이 노드의 다른 필드를 읽게 바뀌면 `ax-prune.cjs` 도 함께 바꿔야 하고 그때는 메인 재설치가 필요하다.

### 새 기본 명령 (입력 처리기 이전)

- `ref.resolve { ref }`: 메인 `cdp-ref-registry` 의 항목을 읽어 `{ backendDOMNodeId, sid }` 를 돌려준다. 오류 문구와 code
  (`no_snapshot` · `stale_ref` · `not_found`)는 옛 `resolveRef` 와 같다. ref 상태는 worker 교체 뒤에도 유지되도록 메인에 둔다.
- `cdp.detachIdle`: 붙어 있으면 CDP 를 뗀 뒤 `{ wasAttached, documentGeneration, debuggerGeneration }` 을 돌려준다.
  ref 없는 selector 클릭이 CDP 없이 누르기 전에 쓴다. worker 는 이 응답으로 이후 호출의 target token 을 바꾼다.
- `focus.state` 응답에 `paint: { ok, why }` 를 더했다. 옛 `cdpExecInner` 의 `WINDOW_NOT_DRAWING` 판정 입력이다.

### 입력 명령 (⑦ 조각 3)

대상: `click` · `dblclick` · `hover` · `fill` · `type` · `key` · `select` · `check` · `scroll` · `scrollto` · `focus` · `clear` ·
`bulkfill`(`INPUT_COMMAND_NAMES`). 명령마다 `COMMAND_ROUTES` 에 따로 등록한다. 옛 `mouse` · `phonekey` · `phonetype` · `phonefocus`
와 QA 입력(`cdp-qa-input.cjs`, `cdp-qa-keys.cjs`)은 이번 범위가 아니며 옛 봉투로 간다.

처리기 본문은 `server/mcp-worker/input-commands.js`(원본 `cdp-cmd-input.cjs` 사본) 그대로이고, 앞뒤 단계는
`server/mcp-worker/input-route.js` 가 옛 `cdpExecRaw` · `cdpExecInner` 와 같은 순서로 기본 명령에 옮겼다.

1. `click`·`dblclick` 이고 `sel` 만 있으면(ref 없음) 먼저 CDP 없이 누른다: `cdp.detachIdle` → `focus.state` →
   (보이는 탭이고 누르기가 사용자 포커스를 옮기지 않으면 `wc.exec` 로 좌표 → `wc.input` 마우스 이벤트 넷, 아니면 `wc.exec` 로 페이지 안 `click()`)
   → 마지막 `tab.state`(`last`). 요소를 못 찾으면 아래 CDP 경로로 내려간다. 이 단계에는 AI 표식이 없다.
2. `cdp.attach` → `ai.enter` → `viewport.ensureReady`.
3. `fill`·`type`·`key` 는 `focus.state` 의 `paint` 를 보고 창이 그림을 내지 않으면 `window_not_drawing` 오류. 키·움직임 명령이고
   탭이 보이지 않으면 `hold.capture { on: true }`.
4. 본문 실행. `ref` 는 `ref.resolve`, 선택자는 `cdp.frames` 와 프레임별 `cdp.send`, `Input.*`·`Runtime.*` 은 `cdp.send`.
   사용자 포커스 판정(`ownsUserFocus`·`pressAllowed`)은 판정 순간마다 `focus.state` 를 읽는다.
5. hold 를 얻었으면 `settleAnimations` 뒤 `hold.capture { on: false }`, 마지막으로 `ai.leave`(성공이면 `last`).
   실패하면 `ai.leave` 는 `last` 없이 보내고 단위를 명시 종료해 관찰 순간을 비우지 않는다(옛 경로와 같음).

옛 경로와 남는 차이: ① 끊긴 세션 재붙임은 옛 경로가 명령 전체를 한 번 다시 실행하고, worker 는 끊긴 `cdp.send` 한 호출만 다시 보낸다.
② `isTabShown` 은 동기 판정이라 가장 최근 `focus.state` 의 `shown` 을 쓴다(`bulkfill` 은 본문 직전에 읽는다).
(최종 응답 가리기와 임시 layout 반환은 위 규칙으로 옛 경로와 맞췄다.)
시험: `test/mcp-worker-input-route.mjs`, 옛 처리기 기록 `test/fixtures/worker-route-input-golden.json`(`cdp-control.cjs` 원문을 vm 에서 실행해 만듦).

### 새 기본 명령 (페이지·읽기·캡처 처리기 이전)

- `cdp.gate { command, url }`: 옛 `cdpExecRaw` 의 로그인 호스트 판정(`attachPolicy.blocked` 이거나 로그인 호스트로 가는 `goto`)과 붙임을
  한 번에 한다. 로그인 호스트면 AI 세션을 떼고, `CDP_FREE_CMDS` 에 없는 명령은 `cdp_blocked` 오류, 있으면 `{ noCdp: true }`. 아니면
  `attachPolicy.touch` + `ensureAttached` 뒤 `{ noCdp: false }`. 응답에 `documentGeneration`·`debuggerGeneration` 이 있고 worker 가 token 을 바꾼다.
- `cdp.sync`: 현재 세대를 읽는다. 대상 탭 검증은 하되 문서·debugger 세대 비교는 하지 않는다(`result.redact` 도 같음).
  명령 도중 이동으로 세대가 올라가도 최종 응답을 가리고 내보내고, `wait` 가 세대를 다시 맞춘다.
- `wc.navHistory { dir: "back"|"forward" }`: 옛 `moveHistory`(`navigationHistory` 우선, 기록이 없으면 `{ moved: false }`, 있으면 이동이
  끝난 뒤 `{ moved: true, url }`). `ok` 키를 쓰지 않는다(응답 봉투로 읽히기 때문).
- `cdp.screencastShot { ms }`: 숨은 탭 촬영의 마지막 수단(debugger 이벤트를 메인에서 씀). `{ data }`(base64 PNG).
- `img.stitch { tiles, W, H, px }`: 전체 페이지 장들을 오프스크린 창에서 이어 붙임. `{ data }`. 장 41개·정수 크기 검사.
- `img.diff { before, after, out, threshold }`, `img.same { prev, data }`: nativeImage 로 두 PNG 를 비교. 절대 경로만 받고 대상 탭이 필요 없다.
  worker 가 상대 경로를 자기 cwd 로 풀어 절대 경로로 보낸다.

worker 는 세대가 올라갈 수 있는 응답(`cdp.attach` · `cdp.detachIdle` · `cdp.gate` · `cdp.sync` · `cdp.reset` · `wc.nav` · `wc.navHistory`)의
`documentGeneration`·`debuggerGeneration` 으로 이후 호출의 target token 을 바꾼다(`GENERATION_COMMANDS`). 이동 명령이 스스로 올린
세대 때문에 뒤따르는 hold 해제·가리기가 `STALE_TARGET` 으로 실패하지 않게 한다.

### 페이지·읽기·캡처 명령 (⑦ 조각 4)

대상 14개(`PAGE_COMMAND_NAMES`): `goto` `wait` `back` `forward` `reload` `viewport` `eval` `locate` `text` `observe` `diff` `screenshot` `pdf`
`shotsizes`. 명령마다 `COMMAND_ROUTES` 에 따로 등록한다. 옮기지 않은 것: `expect`(일반 MCP 에서 `ordinaryCommandDenied` 로 막힌 QA 전용이라
worker 경로에 닿지 않고 iris-qa 가 옛 처리기를 씀), `remoteframe`·`remotewheel`(폰 앱 경로), `a11y`, `url`(조각 1), `snapshot`(조각 2).

본문은 `inspect-commands.js`(원본 `cdp-cmd-inspect.cjs` 사본) · `capture-commands.js`(`cdp-cmd-capture.cjs` 사본, `samePng` 의 `await` 하나만 다름) ·
`capture-tools.js`(`cdp-capture-tools.cjs` 의 CDP 촬영 함수) · `draw-marks.js` 이고, 페이지 이동 6개의 본문과 앞뒤 단계는 `page-route.js` 에 있다.
순서는 옛 `cdpExecRaw` · `cdpExecInner` 와 같다.

1. `cdp.gate`. `noCdp` 이면 CDP 없이: `wait` 는 `wc.info` 의 `loading` 폴링, `text` 는 `wc.exec`, `screenshot` 은 `wc.capture` 로 파일 저장, 나머지(`goto` 등)는 `wc.nav`.
2. `ai.enter`(읽기 전용 명령 `text` `shotsizes` `screenshot` `diff` `locate` `observe` 는 없음).
3. `viewport.ensureReady`. `screenshot` 은 `focus.state` 의 `paint` 를 보고 창이 그림을 내지 않으면 `window_not_drawing`.
4. `goto` `back` `forward` `reload` 는 탭이 보이지 않으면 `hold.capture { on: true }`, 본문 뒤 `settleAnimations`, `hold.capture { on: false }`.
5. 본문. `text` · `locate` 는 `cdp.frames` 뒤 프레임마다 `cdp.send`. `eval` · `locate` · `text` 는 `cdp.send`, `observe` 는 `download.state` · `obs.read` ·
   (`clear` 면 끝에 `obs.clear`) · `wc.info` 와 `cdp.send`, `screenshot` 은 `cdp.send` · `hold.capture` · `ref.resolve`(표시 ref) · `cdp.screencastShot` ·
   `cdp.reset` · `wc.capture` · `img.stitch` · `img.same`, `pdf` 는 `wc.pdf`, `diff` 는 `img.diff`, `shotsizes` 는 `viewport.apply` 와 중첩 `screenshot`
   (중첩도 `cdp.gate` 부터 같은 앞 단계를 지남), `viewport` 는 `viewport.apply`(사람 viewport 를 바꾸는 것은 옛 경로와 같음).
6. `ai.leave`, 마지막 `result.redact`(성공이면 `last`, 실패면 `last` 없이 보내고 `unit.end`).

파일은 worker 가 `artifactDir("shots")`(상태 폴더 `artifacts/shots`) 아래에 쓴다. 메인과 같은 `stateHome()` 규칙이다.
`observe` 의 `moments` 칸은 옛 `attachMoments` 처럼 비운 관찰 순간이 있으면 처리기가 낸 같은 이름 칸을 덮어쓴다.

옛 경로와 남는 차이: ① 끊긴 세션 재붙임은 끊긴 `cdp.send` 한 호출만 다시 보낸다(조각 3 과 같음). ② `screenshot`·`pdf` 의 `url`·`title` 은
본문 시작 직후 `wc.info`(`pdf` 는 인쇄 직후)에서 읽은 값이다. ③ `observe` 의 `limit` 는 `obs.read` 가 150 으로 자른다.
④ `pruneShots` 의 1분 간격 제한은 worker 프로세스마다 따로 센다. ⑤ `screenshot` `diff` 의 상대 `path` 는 worker 의 cwd 기준이다.
⑥ `img.stitch` 는 장 이미지를 base64 로 한 번에 보낸다(실패하면 옛 경로처럼 화면 한 장으로 내려감).
시험: `test/mcp-worker-page-route.mjs`, 옛 처리기 기록 `test/fixtures/worker-route-page-golden.json`(`cdp-control.cjs` 원문과 세 처리기 파일을 vm 에서 실행해 만듦).
이미지는 바이트 대신 같은 입력을 같게 넘기는지(호출 인자·쓴 파일 내용)로 비교한다. 비교 알고리즘(nativeImage)은 메인에 그대로 있다.

### 네이티브 명령 (⑦ 조각 5)

대상 9개(`NATIVE_COMMAND_NAMES`): `dialog` `dialoginfo` `dialogs` `upload` `download` `login` `nativewin` `nativekey` `nativeclick`. 명령마다 `COMMAND_ROUTES` 에
따로 등록하고 `worker-native-commands` 를 알리는 메인에서만 worker 경로를 쓴다. 새 기본 명령은 없다. 기존 `dialog.state` `dialog.plan` `upload.arm`
`download.configure` `login.fill` `native.window` `native.windowClick` `native.windowKey` 를 쓴다.

`dialog` 는 조각 6a 에서 옮겼다: worker `executeOne` 이 `browser.dialogAnswer`(host 확인 창 연산)로 먼저 가져가므로 일반 MCP 경로에서는 이 처리기에 오지 않고,
host 작업 위임이 부른다(본문은 `dialog.answer` 한 번, 옛 `dialog` 응답 모양 `{ ok, none, note }` · `{ ok, answered, kind, message }`). 조각 6a 가 `login.accounts`·`login.input`(QA 로그인)을 쓰고,
`native.click`·`native.key`·`native.drag` 는 아직 쓰는 처리기가 없다.

처리기 본문은 `server/mcp-worker/native-route.js` 에 있고 순서는 옛 `cdpExecRaw` · `cdpExecInner` 와 같다.

1. `cdp.gate`. `noCdp`(로그인 호스트)이면 CDP 없이 본문. `dialoginfo` 는 `CDP_FREE_CMDS` 에 없어 `cdp_blocked`.
2. `ai.enter`(읽기 전용 `dialoginfo` `nativewin` 은 없음).
3. `viewport.ensureReady`. `upload` `nativekey` `nativeclick` 은 `focus.state` 로 보이는 탭인지 보고 아니면 `hold.capture { on: true }`, 본문 뒤
   `settleAnimations`, `hold.capture { on: false }`. `login` 은 hold 만 하고 트랜지션은 기다리지 않는다(옛 `NEEDS_KEYS`, 그림 판정은 면제).
4. 본문. `dialoginfo` → `dialog.state`(문구 300자). `dialogs` → `dialog.plan`(문자열 해석·오류 문구는 worker). `upload` → 경로 해석·존재 검사는 worker,
   `ref`/`sel` 이 있으면 `cdp.send` 로 `DOM.setFileInputFiles`(대상은 `ref.resolve` 또는 프레임별 조회), 없으면 `upload.arm`. `download` → `download.configure`.
   `login` → `login.fill` 뒤 `cdp.sync`. `nativewin`·`nativekey`·`nativeclick` → `native.window`·`native.windowKey`·`native.windowClick`.
5. `ai.leave`, 마지막 `result.redact`(성공이면 `last`, 실패면 `last` 없이 보내고 `unit.end`).

대기열 밖(`outside`) 단위로 실행하는 명령은 옛 `QUEUE_BYPASS` 중 옮긴 `dialog` `dialoginfo` `dialogs` `nativewin` `nativekey` `nativeclick`. 나머지(`upload` `download` `login`)는 옛
경로처럼 탭 대기열의 한 단위다.

로그인 값: worker 는 비밀번호를 갖지 않는다. `login.fill` 이 메인 안에서 provider 로 페이지를 채우고, 메인이 값을 기억(`rememberSecret`)한 뒤 결과에서 지워 돌려준다.
worker 의 최종 응답은 `result.redact` 가 한 번 더 가린다. 사람이 해야 하는 로그인(`needUser`)이면 메인이 붙임 정책을 풀며(옛 `noteLoginResult`) debugger 세대가 오르므로
worker 가 `cdp.sync` 로 token 을 맞춘 뒤 `ai.leave` 를 보낸다. `download.configure` 는 폴더를 만들 수 없으면 `INVALID_REQUEST` 와 옛 문구(`폴더를 만들 수 없습니다: …`)로 실패하고
worker 는 이를 옛 처리기처럼 `{ error }` 값으로 돌려준다.

상태를 남기는 명령(`dialogs` 의 계획, `upload` 의 무장, `download` 의 폴더)은 기본 명령의 자원 기록을 따라 worker 세대가 은퇴(`worker.retire`)하면 풀린다. 옛 경로에는 worker 교체가
없어 계획이 계속 남던 점과 다르다. 새 세대가 같은 자원을 다시 무장했으면 건드리지 않는다.

옛 경로와 남는 차이: ① 로그인 값은 짧아도 가려진다(`login.fill` 이 `allowShort`). ② `dialogs` 의 큐는 100개까지(`dialog.plan` 검사). ③ 잘못된 계획 문자열을 받았을 때 옛 처리기가 먼저 바꾸던
`plan.text` 를 바꾸지 않는다. ④ 로그인 제공자가 없을 때의 오류 문구(앱 내부 오류). ⑤ 끊긴 세션 재붙임은 끊긴 호출 한 번만 다시 보낸다(조각 3 과 같음).
시험: `test/mcp-worker-native-route.mjs`, 옛 처리기 기록 `test/fixtures/worker-route-native-golden.json`(`cdp-control.cjs` 원문과 `cdp-cmd-native.cjs` 를 vm 에서 실행해 만듦).
worker 경로 쪽은 실제 worker 서비스 · host 확인 창 게이트 · 명령 단위 · Electron 중계를 거치고 메인 모듈만 대역이다.

### QA 입력·로그인·화면 크기·QA 모드 (⑦ 조각 6a)

대상 9개(`QA_COMMAND_NAMES`, `server/mcp-worker/qa-route.js`): `qa-input` `qa-select-resolve` `qa-locate` `qa-focused` `qa-login-info` `qa-login-input`
`qa-viewport` `qa-viewport-state` `qa-mode`. `COMMAND_ROUTES` 에 따로 등록하고 `worker-qa-input-commands` 를 알리는 메인에서만 worker 경로를 쓴다.
호출 자리는 `qa-service.js` 의 `createQaExecutor`(`execute`·`modeOff`)이고, QA 표의 이름과 일반 이름 8개(`QA_GENERIC_NAMES`: `goto` `url` `snapshot` `diff` `wait` `back` `forward` `reload`)가 처리기를 쓴다. 일반 이름은 일반 MCP 와 같은 처리기를 QA 표시(`iris-qa`)로 실행하고, 메인이 그 명령의 기능을 알리지 않으면 옛 봉투로 보낸다(`test/mcp-worker-qa-generic-route.test.mjs`).

QA 채널의 순서는 그대로다: `qa-mode` 켜기 단위 → 명령 단위. 두 단위는 다른 `commandId`(`<요청>/unit/<uuid>`)로 보낸다. 같은 commandId 로 이으면 앞 단위가
닫힌 뒤의 자원 반환(`releaseCommand`)이 뒤 단위가 얻은 표식까지 거두기 때문이다. 회차 종료의 `qa-mode` 해제는 단위 이름 `qa-mode-off` 로 보내며 host 확인 창 게이트가
이 이름과 `redact` 를 통과시킨다(F13: 켜기는 열린 확인 창에 막히고 해제·`qa-dialog-answer` 는 막히지 않음). `qa-dialog-state`·`qa-dialog-answer` 는 host 확인 창 연산 그대로이고
그 안의 Electron 실행만 위 「host 작업 위임」이다.

처리기 순서는 옛 `cdpExecRaw` · `cdpExecInner` 와 같다.

1. `cdp.gate`. QA 명령은 `CDP_FREE_CMDS` 에 없어 로그인 호스트에서는 `cdp_blocked`.
2. `ai.enter`. 읽기 전용 `qa-login-info` `qa-select-resolve` `qa-viewport-state` 는 없음.
3. `viewport.ensureReady`. 메인이 옛 `ensureQaReady` 를 부른다: QA 탭이면 호스트 확대 보정, 아니면 숨은 탭 준비.
4. 키가 필요한 `qa-input` `qa-login-input` 만: `focus.state` 로 창 그림 검사(`window_not_drawing`) → 보이지 않는 탭이면 `hold.capture` → `cdp.frames` → 입력 수신용 `cdp.subscribe`(`scoped`).
5. 본문. `qa-input` `qa-select-resolve` `qa-locate` `qa-focused` 는 옛 `cdp-qa-input.cjs` 사본(`qa-input-commands.js` `qa-keys.js` `qa-login-page.js`)을 실행하고 `cdp.send` 로 CDP 를 부른다.
   `qa-viewport` → `viewport.qa`, `qa-viewport-state` → `viewport.get` 의 `current`, `qa-mode` → `qa.mode`.
6. `cdp.unsubscribe`, `hold.capture { on: false }`, `ai.leave`, 마지막 `result.redact`.

사본의 `wc.debugger.on("message")`(`Runtime.bindingCalled`)는 `cdp.subscribe` 이벤트로, `wc.sendInputEvent` 는 `wc.input` 으로 바뀐다. 단위가 확인 창으로 막혀 닫히면 메인이
`releaseCommand` 에서 빌린 사용자 포커스(`focus.return`), `hold.capture`, `ai.enter` 표식, `scoped` 구독을 반환한다.

로그인(비밀번호 원문은 worker 에 오지 않는다): `login.accounts { qa: true, approved }` 는 옛 `accountsFor` 와 같은 검사·계정 id(`sha256(origin + "\\n" + username)` 앞 24자)로 공개 필드
(`id` `username` `allowed` `local`)만 돌려주고, 입력값은 메인이 `rememberSecret` 한다. 같은 단위의 `login.input` 이 목록을 다시 읽지 않도록 메인이 단위에 캐시하고, 입력하면 버린다.
`login.input { qa: "check" | "cdp" | "chars" }`: `check` 는 길이만, `cdp` 는 `Input.insertText`, `chars` 는 `char` 키 이벤트로 메인 안에서 값을 넣는다. worker 는 `qa-input` 사본에 한 글자
자리표시(`U+E000`)를 넘기고, 자리표시가 `Input.insertText` 나 `char` 키로 나오는 자리에서 `login.input` 을 부른다. `qa` 인자가 없는 기존 `login.input` 은 그대로다.

메인에 새로 생긴 동작(앱 재시작 필요): `login.accounts`·`login.input` 의 `qa` 방식, `cdp.subscribe` 의 `scoped`, 단위 닫힘 때 포커스 반환, QA 탭의 `viewport.ensureReady`.

옛 경로와 남는 차이: ① 입력 수신 이벤트가 메인 → 공용 서버 → worker 를 거쳐 늦게 올 수 있다(옛 페이지 기록 읽기 폴백은 유지). ② 로그인 제공자가 없을 때의 오류 문구. ③ 확인 창으로
막힌 뒤에도 처리기가 이후 호출을 보내 각각 같은 막힘 응답을 받는다. ④ `isTabShown` 은 단위 앞의 `focus.state` 값이다. ⑤ 일반 오류에 붙는 `code: "INTERNAL"` 은 응답에서 뗀다
(`StepFailed`, 모든 worker 처리기에 적용). 시험: `test/mcp-worker-qa-input-route.mjs`(옛 처리기 기록 `test/fixtures/worker-route-qa-input-golden.json`), `test/electron-relay-qa-input.mjs`,
`test/mcp-worker-native-route.mjs`.

⑦ 에서 옮기는 처리기가 사용하는 기본 명령은 다음과 같다(조각 6b 에서 모두 반영 · 처리기마다 옮김/남김은 아래 「⑦ 처리기 이전 정리」). 처리기 안의 분기·응답·재시도는 worker로
옮기고 표에 적은 Electron 상태만 기본 명령으로 읽거나 바꾼다.

| 옮길 처리기 | 사용할 기본 명령 |
| --- | --- |
| `cdp-cmd-page.cjs` | `cdp.send`, `wc.nav`, `viewport.apply`, `viewport.ensureReady` |
| `cdp-cmd-input.cjs`, `cdp-qa-input.cjs`, `cdp-qa-keys.cjs` | `cdp.send`, `cdp.batch`, `wc.input`, `focus.state`, `focus.prepare`, `focus.return`, `viewport.ensureReady` |
| `cdp-cmd-inspect.cjs`, `cdp-qa-expect.cjs`, `cdp-qa-stability.cjs` | `cdp.send`, `cdp.batch`, `cdp.frames`, `obs.read`, `obs.pending`, `download.state` |
| `cdp-cmd-capture.cjs`, `cdp-qa-capture.cjs` | `cdp.send`, `cdp.batch`, `wc.capture`, `hold.capture`, `img.render`; `wc.info`의 `zoom` |
| `cdp-cmd-native.cjs` | `dialog.state`, `dialog.answer`, `dialog.plan`, `upload.arm`, `download.state`, `download.configure`, `login.accounts`, `login.fill`, `login.input`, `native.window`, `native.windowClick`, `native.windowKey` |
| `cdp-qa-login.cjs` | `login.accounts`, `login.input` |
| `cdp-qa-viewport.cjs` | `viewport.qa`; `wc.info`의 `zoom` |
| `cdp-qa-reaction.cjs`, `cdp-observation.cjs`의 worker 처리 | `cdp.subscribe`, `cdp.unsubscribe`, `obs.read`, `obs.pending`, `obs.since`, `cdp.send`, `cdp.frames`, `hold.capture`, `wc.info`, `img.render`, `result.redact` (`obs.drain`·`obs.clear` 는 일반 `observe` 가 씀) |
| `cdp-overlay.cjs`, `cdp-ref-registry.cjs`의 worker 처리 | `cdp.send`, `cdp.batch`, `cdp.frames` |
| `cdp-context-action.cjs` | `contextaction` |
| QA 진입·종료 | `qa.mode` |

### QA 확인·캡처·관찰·반응 (⑦ 조각 6b)

대상 10개(`QA_OBSERVE_COMMAND_NAMES`, `server/mcp-worker/qa-observe-route.js`): `qa-expect` `qa-screenshot` `qa-observe` `qa-settle` `qa-reaction-start` `qa-reaction-poll`
`qa-reaction-end` `qa-reaction-drain` `qa-target-resolve` `qa-background-observe`. `COMMAND_ROUTES` 에 따로 등록하고 `worker-qa-observe-commands`(와 `worker-qa-input-commands`)를
알리는 메인에서만 worker 경로를 쓴다. 호출 자리는 `qa-service.js` 의 `createQaExecutor.execute`(`screenshot`·`observe` 는 `qa-screenshot`·`qa-observe` 로 바꿔 부른다).
메인이 이 기능만 모르면(이전 설치 앱) 이 열 개만 옛 봉투로 가고 6a 의 `qa-mode` 단위는 그대로다. 모두 `qa-` 로 시작해 일반 MCP 명령으로 고를 수 없다(`ordinaryCommandDenied`).

처리기 순서는 6a 와 같다: `cdp.gate` → `ai.enter`(읽기 전용이 아니면) → `viewport.ensureReady` → 창 그림 검사(`qa-screenshot` 만, `focus.state` 의 `paint`) → `cdp.frames` →
본문 → `ai.leave` → 마지막 `result.redact`. 옛 `READ_ONLY_CMDS` 에 없는 `qa-expect` 만 `ai.enter` 를 건다. `qa-expect` 안의 촬영은 옛 `cdpExecRaw` 중첩 호출처럼
관문·준비·창 검사를 한 번 더 지난다. 본문은 `qa-expect-commands.js` `qa-capture-commands.js` `qa-stability.js` 사본이고, 메인 동기 조회는 기본 명령이다:
`wc.info`(url·title·zoom·wcId), `ref.resolve`, `img.render`(마스킹), `hold.capture`, `obs.read`, `result.redact`(캡션·표시·진단 응답을 가림), `obs.pending`.
화면 파일은 worker 가 `artifacts/shots` 에 쓴다. PNG 크기 검사는 Electron `nativeImage` 대신 PNG 머리말(IHDR)을 읽는다(`pngSize`).

반응 관찰(`qa-reaction-*`·`qa-target-resolve`·`qa-background-observe`)은 상태가 명령 하나보다 오래 산다. 상태(`active` 표, 장면, 후보, 기대 효과)는 worker 의 `qa-reaction-commands.js`
(`createQaExecutor` 마다 하나)에 두고 호스트 탭 id 로 구분한다. 판정 본문(`reactionWatch` 주입 함수, `ingest`, 기대 효과 판정, 시작 검사, 종료 판정, `qa-target-resolve`)은 원본과 글자까지 같다.

- 구독: `qa-reaction-start` 가 `cdp.subscribe`(`scoped` 아님, `ingest` 가 읽는 method 11개만)로 이벤트를 받고, 이벤트는 메인 → 공용 서버 → worker 로 와서 `ingest` 에 들어간다.
  구독은 `qa-reaction-end` 뒤 idle 상태에서도 남고(옛 `hasActive`), 다음 `start` 가 이전 관찰을 정리하거나 `qa-mode` 해제(`qa-route.js`, 옛 `setQaMode` 의 `dispose` 자리)가 정리한다.
  정리는 주입 스크립트 제거(`Page.removeScriptToEvaluateOnNewDocument`), 격리 영역 정지, `cdp.unsubscribe` 다.
- CDP 유지: 메인의 부착 정책이 `scoped` 가 아닌 구독이 있는 탭(`relay.hasPersistentSubscription`)을 옛 `qaReactionCommands.hasActive` 와 같이 CDP 를 떼지 않는 이유로 센다.
- 장면 촬영: 이벤트는 열린 명령 단위가 없을 때도 온다. 옛 경로는 이벤트 처리 안에서 `qa-screenshot` 본문을 대기열 밖에서 바로 불렀으므로, worker 는 장면마다 새 commandId
  (`<요청>/unit/<uuid>`)의 대기열 밖(`outside`) 단위를 열어 같은 촬영 본문을 실행한다. 이전 명령의 token 은 낡았을 수 있어(host 가 현재 문서 세대와 비교해 거절) 호스트에서 현재 target token 을 다시 받고,
단위가 닫히면 메인이 hold 를 반환한다.
  관문·준비·창 검사는 옛 경로처럼 거치지 않는다.
- 진단: 종료 응답의 `observation` 은 기본 명령 `obs.since { since }` 의 `{ diag }` 다. `diagSince` 결과의 `moments` 배열이 응답 최상위에 있으면 명령 단위가 비운 관찰 순간으로 읽어
  처리기 응답을 덮어쓰므로 `diag` 로 감쌌다(`wc.navHistory` 의 `ok` 와 같은 종류의 함정).
- 이벤트 상한: 구독 이벤트가 상한을 넘으면 메인이 구독을 끊고 `EVENT_OVERFLOW` 를 보낸다. 관찰 결과의 `limits` 에 `{ code, message }` 로 남는다(옛 경로에는 상한이 없었다).
- worker 교체: 활성 관찰은 `activity` 의 `observations` 로 이미 세어지므로 교체는 활성 관찰이 있으면 거부된다(supervisor 규칙 그대로). `stopObservations` 후에도 idle 상태가 남을 수 있어
  worker 세대 은퇴(`worker.retire`)가 구독·스크립트·바인딩을 거둔다.

host 작업 위임의 `screenshot`(journal)은 위 「host 작업 위임」처럼 일반 `screenshot` 처리기를 쓴다. 창 그림 검사(`focus.state` 의 `paint`)·`hold.capture`·QA 탭의 `viewport.ensureReady`
(옛 `ensureQaReady`)는 일반 처리기가 이미 같은 기본 명령으로 한다.

새 기본 명령(앱 재시작 필요): `obs.pending { }` → `{ pending }`(옛 `observation.pendingRequests`), `obs.since { since }` → `{ diag }`(옛 `observation.diagSince`),
`cdp.subscribe` 의 `scoped` 기록(부착 정책 유지 판정). 메인 기능 이름 `worker-qa-observe-commands`.
명령 단위는 사용자 명령 이름이 `qa-` 로 시작하면(`qa-mode-off` 포함) 끊긴 디버거 세션을 다시 붙여 재시도하지 않는다. 옛 `execWithReattachRaw` 가 QA 명령을 재붙임 대상에서 뺐고,
반응 관찰이 심은 스크립트·바인딩이 새 세션에 없어 조용히 틀어지기 때문이다(6a 의 QA 명령에도 같이 적용된다).

옛 경로와 남는 차이: ① 구독 이벤트가 IPC 를 거쳐 늦게 온다(반응 시각은 worker 의 `now()`). ② 단위가 호출마다 응답을 메인의 비밀 가리기에 거쳐 `qa-expect` 가 비밀 글자와 직접
비교하면 가려진 값과 비교한다(`test/mcp-worker-qa-observe-route.mjs` 의 「알려진 차이」). ③ 확인 창이 떠 있을 때 장면 촬영은 host 게이트가 막아 `shotError` 문구가 다르다(옛 경로는 3초 시간 상한).
④ 이벤트 상한(`limits`). ⑤ 이벤트 payload 의 비밀도 메인이 가린다. ⑥ 일반 이름(`goto`·`url`·`snapshot`·`diff` 등)의 QA 채널 호출도 worker 처리기로 간다(아래 정리표).
시험: `test/mcp-worker-qa-observe-route.mjs`(옛 처리기 기록 `test/fixtures/worker-route-qa-observe-golden.json`, 시나리오 `test/fixtures/qa-observe-route-scenarios.mjs`).
옛 경로는 `cdp-control.cjs` 의 `cdpExecRaw`·`cdpExecInner`·`setQaMode` 원문을 vm 에서 실행하고 실제 `cdp-qa-*.cjs` 처리기를 쓴다. 반응 시계는 시험용으로 주입한다.

### ⑦ 처리기 이전 정리: 처리기마다 옮김/남김

`native/electron/` 의 처리기 모듈별 결과다. 「옮김」은 worker 처리기가 있고 경로 표가 `worker`, 「남김」은 Electron 에 상태가 있거나 부르는 자리가 메인이라 기본 명령·옛 처리기로 둔 것이다.
옛 처리기 파일은 모두 ⑧ 에서 삭제하지 않고 확인한 뒤 옮긴 본문만 제거한다(남김은 계속).

| 처리기 | 결과 | worker 쪽 | 남는 Electron 상태·이유 |
| --- | --- | --- | --- |
| `cdp-cmd-page.cjs` | 옮김: `goto` `wait` `back` `forward` `reload` `viewport`. 남김: `url` | `page-route.js` · `url` 은 `command-routes.js` | `url` 은 `wc.info` 한 번이라 처리기를 옮기고 옛 본문을 둠(이번 단계 유지) |
| `cdp-cmd-input.cjs` | 옮김: 입력 13개 | `input-route.js` `input-commands.js` | 남김: `phonekey` `phonefocus` `phonetype`(폰 앱 경로, Iris 탭 입력이 아님) |
| `cdp-cmd-inspect.cjs` | 옮김: `snapshot` `eval` `locate` `text` `observe`. 남김: `expect` | `command-routes.js` `page-route.js` `inspect-commands.js` | `expect` 는 QA 전용이라 일반 MCP 에서 막혀 있고 QA 판정은 `qa-expect`(옮김). 사본은 `inspect-commands.js` 에 있으나 경로 없음 |
| `cdp-cmd-capture.cjs` | 옮김: `diff` `screenshot` `pdf` `shotsizes`. 남김: `remoteframe` `remotewheel` | `page-route.js` `capture-commands.js` | 폰 앱 경로. journal `screenshot` 은 조각 6b 에서 옮김 |
| `cdp-cmd-native.cjs` | 옮김: 9개(`dialog` `dialoginfo` `dialogs` `upload` `download` `login` `nativewin` `nativekey` `nativeclick`) | `native-route.js` | 계획·무장·폴더·로그인 값은 메인 상태(기본 명령) |
| `cdp-qa-input.cjs` `cdp-qa-keys.cjs` | 옮김 | `qa-route.js` `qa-input-commands.js` `qa-keys.js` | 사용자 포커스(`focus.*`)·합성 입력은 메인 |
| `cdp-qa-login.cjs` | 옮김(로그인 칸 판정) | `qa-route.js` `qa-login-page.js` | 계정 목록·비밀 입력은 메인(`login.accounts` `login.input`) |
| `cdp-qa-viewport.cjs` | 옮김(호출) · 상태 남김 | `qa-route.js` → `viewport.qa` `viewport.get` | 기기 에뮬레이션 상태가 메인 |
| `cdp-qa-capture.cjs` | 옮김: `qa-screenshot` `qa-observe` `qa-settle`. 남김: `imageRenderer` | `qa-observe-route.js` `qa-capture-commands.js` | 그림 합성(offscreen `BrowserWindow`)은 `img.render` |
| `cdp-qa-expect.cjs` `cdp-qa-stability.cjs` | 옮김: `qa-expect` · 안정 확인 | `qa-observe-route.js` `qa-expect-commands.js` `qa-stability.js` | 대기 요청 수는 `obs.pending` |
| `cdp-qa-reaction.cjs` | 옮김: 반응 관찰 6개 · 대상 해석 | `qa-observe-route.js` `qa-reaction-commands.js` | 이벤트 수신기는 메인(`cdp.subscribe`), CDP 유지는 부착 정책 |
| `cdp-observation.cjs` | 남김 | 기본 명령 `obs.read` `obs.drain` `obs.clear` `obs.pending` `obs.since` · `cdp.subscribe` | 진단 버퍼·관찰 순간·확인 창 상태·이벤트 허브·애니메이션 판정이 모든 탭의 디버거 메시지를 동기로 받는 메인 상태 |
| `cdp-context-action.cjs` | 남김 | 기본 명령 `contextaction` 만 있음 | 부르는 자리가 메인 안 원격 기능(`server/remote/features/browser.js` 번역 → `runCdp`)이라 worker 호출자가 없고, 제한 시간이 35초라 명령 단위(25초)로 옮기면 짧아진다 |
| `cdp-overlay.cjs` `cdp-ref-registry.cjs` | 남김 | `ref.record` `ref.resolve` | 사용자가 받은 ref 가 worker 교체 뒤에도 유지돼야 함(registry). overlay 는 지목·스케치 UI 가 메인에서 부름 |
| `cdp-capture-tools.cjs` `cdp-layout.cjs` `cdp-hints.cjs` | 남김(worker 에 사본) | `capture-tools.js` `layout.js` `page-hints.js` | 옛 처리기와 원격 프레임·CLI 경로가 계속 부름. ⑧ 에서 호출자가 없으면 삭제 |
| `cdp-hidden-viewport.cjs` `cdp-device-emulation.cjs` `cdp-attach-policy.cjs` `cdp-session.cjs` `cdp-transport.cjs` `cdp-result-safety.cjs` `cdp-upload.cjs` `cdp-native-ax.cjs` | 남김 | 기본 명령(`viewport.*` `cdp.attach` `cdp.gate` `result.redact` `upload.arm` `native.*` 등) | 동기 판정과 사람 쪽 상태(설계 H절): 부착·세션·debugger-pin, 비밀 가리기, 기기 에뮬레이션, 업로드·확인 창 자동 응답, 네이티브 접근성 |
| `cdp-control.cjs` | 남김(조립 · CDP 중계) | 경로 표 + 단위 실행 | 옛 봉투 분기가 남음: worker 메타가 없는 봉투와 경로 `legacy` 명령 |

QA 채널이 보내는 일반 이름 `goto` `url` `snapshot` `diff` `wait` `back` `forward` `reload` 는 `QA_GENERIC_NAMES` 로 worker 처리기에 연결했다. 처리기 결과는 일반 MCP 경로의 golden 이 옛 처리기와 대조하고,
QA 채널 경로 선택은 `test/mcp-worker-qa-generic-route.test.mjs` 가 정한다. 실제 앱에서 `goto` `snapshot` `back` `forward` `reload` `diff` 를 QA 회차로 실행해 확인했다. `qa-dialog-state` `qa-dialog-answer` 는 host 확인 창 연산이다.

### 명령별 처리 경로 (⑦ 진행)

worker는 명령마다 `server/mcp-worker/command-routes.js`의 `COMMAND_ROUTES`로 경로를 고른다. `worker`는
worker 안 처리기가 기본 명령을 부르고, `legacy` 또는 표에 없는 명령은 옛 Electron 처리기 봉투로 보낸다.
값만 바꿔 worker를 교체하면 되돌아가며 앱 재시작은 필요 없다. 같은 응답인지는
`test/mcp-worker-command-routes.mjs`와 옛 처리기 응답 기록 `test/fixtures/worker-route-url-golden.json`이 확인한다.

| 명령 | 경로 | 사용한 기본 명령 | 옛 처리기 |
| --- | --- | --- | --- |
| `url` | `worker` | `wc.info` (`url`·`title`만 응답) | `cdp-cmd-page.cjs` `url` (이번 단계에서 유지) |
| `snapshot` | `worker` | `cdp.attach`, `viewport.ensureReady`, `cdp.frames`, `cdp.send`, `ref.record`, `wc.info` | `cdp-cmd-inspect.cjs` `snapshot` (⑧에서 삭제) |
| `click` `dblclick` `hover` `fill` `type` `key` `select` `check` `scroll` `scrollto` `focus` `clear` `bulkfill` | `worker` | 아래 「입력 명령」 | `cdp-cmd-input.cjs` (⑧에서 삭제) |
| `goto` `wait` `back` `forward` `reload` `viewport` `eval` `locate` `text` `observe` `diff` `screenshot` `pdf` `shotsizes` | `worker` | 위 「페이지·읽기·캡처 명령」 | `cdp-cmd-page.cjs` · `cdp-cmd-inspect.cjs` · `cdp-cmd-capture.cjs` (⑧에서 삭제) |
| `dialog` `dialoginfo` `dialogs` `upload` `download` `login` `nativewin` `nativekey` `nativeclick` | `worker` | 위 「네이티브 명령」 (`dialog` 는 host 작업 위임이 부름) | `cdp-cmd-native.cjs` (⑧에서 삭제) |
| `qa-input` `qa-select-resolve` `qa-locate` `qa-focused` `qa-login-info` `qa-login-input` `qa-viewport` `qa-viewport-state` `qa-mode` | `worker` | 위 「QA 입력·로그인·화면 크기·QA 모드」 | `cdp-qa-input.cjs` · `cdp-qa-keys.cjs` · `setQaMode` (⑧에서 삭제) |
| `qa-expect` `qa-screenshot` `qa-observe` `qa-settle` `qa-reaction-start` `qa-reaction-poll` `qa-reaction-end` `qa-reaction-drain` `qa-target-resolve` `qa-background-observe` | `worker` | 위 「QA 확인·캡처·관찰·반응」 | `cdp-qa-capture.cjs` · `cdp-qa-expect.cjs` · `cdp-qa-stability.cjs` · `cdp-qa-reaction.cjs` (⑧에서 삭제) |
| `redact` | `worker` | `result.redact` (host 작업 위임 전용) | `cdp-control.cjs` `redact` |

옛 처리기의 `url`은 응답에 관찰 순간(`moments`)을 비우며 덧붙일 수 있다. worker 경로도 마지막 기본 명령(`wc.info`)의 단위 닫힘이 같은 비움을 하므로(「명령 단위 실행」)
조각 6b 에서 `obs.drain` 을 따로 쓰지 않았다. `obs.drain` · `obs.clear` 는 기본 명령으로 남아 있고 일반 `observe` 가 `obs.clear` 를 쓴다.

`viewport.apply`는 기존 기기 emulation의 UA·터치·메인 viewport 상태 갱신을 함께 실행한다.
`viewport.setTemporary`는 명령 중 잠시 쓰는 크기이며 둘을 바꾸어 쓰지 않는다. `dialog.plan`,
`download.configure`, `qa.mode`, `viewport.ensureReady`, `viewport.qa`가 만든 임시 상태는 worker retire 때
해제한다. 사람이 설정한 viewport와 일반 `viewport.apply` 결과는 유지한다.

### 공통 대상 검증

Electron 메인은 target이 있는 모든 명령에서 다음을 명령 직전에 확인한다.

1. 현재 Iris가 소유한 guest `webContents`인지 확인한다. 등록된 사이트 팝업은 guest로 허용하고 앱 셸
   `webContents`는 거부한다.
2. CDP 연결이 필요한 명령은 현재 URL과 진행 중 탐색 URL이 debugger 부착 정책을 모두 통과하는지
   확인한다. `wc.info`·`wc.nav`처럼 Electron API만 쓰는 명령은 로그인 호스트에서도 허용한다.
3. target token의 문서 세대와 debugger 세대가 현재 값과 같은지 확인한다.
4. child session id가 그 `webContents`와 현재 debugger 세대에 속하는지 확인한다.
5. `workerGeneration`이 현재 허용 세대이고 `commandId`가 그 세대에 속하는지 확인한다.

lifecycle 명령의 `commandId`는 `<workerGeneration>/lifecycle/<run>/<uuid>` 형식을 쓴다. 세대 접두가
없으면 `INVALID_REQUEST`와 필요한 형식을 반환한다.

`batch`, `reset`, subscribe 계열도 같은 검사를 받는다. `qa.anchor`처럼 target이 없는 명령은 현재
worker 세대, run, anchor 파일 경계만 허용한다. 기본 명령은 일반 MCP 요청 이름으로 공개하지 않는다.

`login.input`은 account id, origin, 대상 필드, 좌표와 선택적 `approved`를 받는다. `approved: true`는
그 요청 한 번에만 저장 계정 사용을 승인한다. Electron 메인은 같은 승인 조건으로 계정을 조회하고
실제 입력 직전 origin과 필드를 다시 확인한 뒤 값을 입력한다. 승인이 없으면 기존 허용 목록 밖의 계정을
거부한다. 원문 비밀번호는 worker와 공용 서버 응답에 포함하지 않는다.
비밀 가리기는 `cdp.send` 결과뿐 아니라 `wc.exec`, 관찰 결과, 이벤트, 오류에도 적용한다.

`focus.state`는 `{ canSendKeys, canPress, shown, shownKnown }`을 반환한다. 사용자 포커스와 렌더러가
보고한 표시 탭 상태를 읽기만 하며 세대 자원이나 포커스 반환 의무를 만들지 않는다.

이벤트 구독 응답은 구독이 설치된 뒤 `subscribed`를 반환한다. 이벤트는 구독별 단조 `eventSeq`를
갖는다. Electron에서 공용 서버로 아직 전달되지 않은 이벤트에만 1,000개 또는 4 MiB 중 먼저 도달하는
상한을 적용한다. 전달이 끝난 이벤트는 상한 계산에서 뺀다. 오래 켜 둔 관찰과 screencast는 전달이
계속되는 동안 재구독 없이 이벤트를 받는다. 상한을 넘으면 오래된 이벤트를 조용히 버리지 않고
`EVENT_OVERFLOW`로 구독을 종료한다. screencast ACK처럼 Electron이 즉시 처리해야 하는 응답은 메인에서
끝낸다.

Electron은 구독 이벤트를 다음 봉투로 보낸다. 공용 서버는 `event.workerGeneration`이 현재 worker
세대인지 확인하고 그 세대가 등록한 `event.subscriptionId`와 `eventSeq`를 대조한 뒤 worker에 전달한다.
재연결 대기열에서 이전 세대 이벤트가 늦게 도착해도 이 세 값으로 버린다.

```json
{
  "type": "relay-event",
  "event": {
    "workerGeneration": "81c9f850c2784f9f:7",
    "subscriptionId": "reaction:run-1",
    "eventSeq": 12,
    "method": "Runtime.bindingCalled",
    "params": {},
    "childSessionId": "optional-child-session"
  }
}
```

상한 초과 봉투는 같은 세 식별 필드와 `error: { code: "EVENT_OVERFLOW", message }`를 가지며
`method`, `params`, `childSessionId`는 넣지 않는다.

### 세대 통지와 자원 회수

Electron 메인은 연결, 탐색, reset, detach, destroy 때 `documentGeneration`과
`debuggerGeneration` 변경을 공용 서버에 알린다. 공용 서버는 현재 worker에 전달하고 이전 세대의 ref,
child session, 캐시를 폐기하게 한다.

등록된 사이트 팝업도 생성할 때 두 세대를 발급하고 실행기가 다시 연결되면 현재 값을 다시 보낸다.
팝업이 닫히면 두 세대를 폐기한다. 앱 셸 창은 이 등록 절차에 들어가지 않는다.

worker 종료 시 공용 서버는 Electron에 `worker.retire`를 보낸다. Electron은 다음 순서를 지킨다.

1. 그 worker 세대의 새 요청 차단
2. 진행 중 명령 취소 요청과 실제 종료 확인
3. AI ticket, capture hold, focus, 명령이 설정한 임시 viewport 반환
4. subscribe, Runtime binding, 주입 스크립트, screencast, dialog·upload 계획 해제
5. `worker.retired` 응답
6. 공용 서버가 새 worker 세대를 허용

자원 등록 기록에는 당시 debugger 세대와 child session을 함께 둔다. 반환할 때 그 debugger 세대나
child session이 이미 사라졌으면 해당 CDP 자원은 반환된 것으로 처리한다. binding, document script,
screencast에 같은 규칙을 적용한다.

dialog plan, QA mode, 임시·QA·hidden viewport, 앱 전체 download 설정, capture hold, Runtime binding,
screencast, upload plan은 자원별로 소유 worker 세대와 설정 순번을 기록한다. 이전 세대 자원을 반환하기
직전에 같은 webContents의 같은 자원을 새 owner가 설정했는지 다시 확인한다. 새 설정이 있으면 Electron
상태를 바꾸지 않고 이전 세대 기록만 지운다. 같은 자원의 설정과 반환은 순서대로 실행한다. capture
hold는 새 세대가 기존 hold를 이어받아 중복 획득하지 않는다. download는 이전 세대가 설정한 폴더와
one-shot 값이 현재도 같을 때만 해제한다. leftovers 재시도에도 같은 확인을 적용한다.

임시·QA·hidden viewport 사이에서 자원 종류가 바뀌면 새 owner가 이전 owner의 시작 viewport와 복원
책임을 함께 이어받는다. 마지막 owner를 반환할 때 중간 viewport를 역순으로 해제한 뒤 사람이 정한
원래 viewport로 돌아간다.

새 공용 서버의 boot id를 가진 세대가 들어오거나 실행기 소켓이 바뀌면 Electron은 이전 owner를 위
순서로 반환한 뒤 새 세대를 허용한다. 같은 boot id의 일반 `accept`는 기존 owner의 명시적 retire
전까지 `BUSY`로 거부한다. 일반 activate는 retire 뒤 accept하는 순서를 유지한다.

공용 서버가 재시작하면 실행기 재등록 때 새 boot id의 `accept`를 보낸다. 이전 연결에서 보내지 못한
`retire`가 있으면 그 `retire`를 먼저 다시 보내고 현재 세대를 `accept`한다. Electron은 새 boot id를
받으면 이전 boot의 세대를 위 순서로 정리한다. 어느 쪽에서 재시작을 먼저 관찰해도 이전 세대 종료를
확인한 뒤 새 세대를 허용한다.

자원 반환이 실패하면 이전 세대는 `retiring` 상태에 남는다. 같은 세대의 `retire`나 새 boot id·새
실행기 소켓의 다음 `accept`는 남은 자원 반환을 다시 시도한다. 반환이 끝나기 전에는 새 세대에
`BUSY`를 반환하고, 반환이 끝난 요청에서 새 세대를 허용한다. takeover나 force retire에서 생긴
leftovers 반환은 이 규칙의 예외이며 아래 강제 복구 계약을 따른다.

사람이 설정한 viewport와 기기 크기는 반환 대상이 아니다. 이전 세대의 실행이 끝났는지 확인하지
못하면 일반 retire에서는 새 세대를 허용하지 않는다. `wc.nav`의 back·forward·reload는 main-frame의
`did-navigate`, `did-navigate-in-page`, `did-fail-load` 중 하나나 10초 상한까지 기다린 뒤 응답한다.

### 강제 복구

감독기의 recover와 재시작 상한 뒤 자동 재기동은 새 세대 `accept`에 `takeover: true`를 넣는다. 일반
activate는 takeover를 보내지 않는다.

Electron이 같은 boot의 다른 세대에 `takeover: true`를 받으면 기존 세대가 `accepting`이나 `retiring`인
경우에도 즉시 `retired`로 표시하고 새 세대를 받는다. 기존 세대의 진행 중 명령에는 취소를 요청한다.
자원 반환은 새 세대 접수 뒤에 실행하며 반환 호출마다 5초 상한을 둔다. 실패하거나 상한을 넘은 자원은
세대별 leftovers에 남겨 다음 accept·retire 때 다시 시도한다. leftovers 반환은 accept와 retire 응답을
막지 않는다.

공용 서버가 `worker.retire`에 `force: true`를 넣은 경우에도 같은 비차단 반환과 호출별 상한을 적용한다.
성공 응답의 `data`는 `{ retired: true, forced: true, leftovers: [남은 자원 설명] }`이다. 진행 중이던
이전 세대 명령이 은퇴 뒤 자원을 얻으면 Electron은 그 자원을 leftovers에 기록하고 즉시 반환을
시작한다. 해당 명령과 이전 세대의 이후 명령은 `STALE_WORKER`를 받는다.

capture hold는 세대별·탭별 획득 횟수를 기록한다. 명시적 해제와 retire는 그 세대가 기록한 횟수만큼만
메인 capture hold 해제를 호출한다.

## 배포 manifest와 활성화

배포 폴더는 `<상태 폴더>/mcp-worker/<deployId>/`다. `deployId`는 커밋 SHA, 설치 bundle id 해시,
추적·비추적 작업 트리 내용 해시로 만든다. 폴더에는 `manifest.json`과 `.complete.json`이 있어야 한다.

```json
{
  "schemaVersion": 1,
  "deployId": "eb90977-<bundle-id-sha256>-<worktree-sha256>",
  "createdAt": "2026-11-01T08:00:00.000Z",
  "source": { "commit": "eb90977...", "worktreeSha256": "..." },
  "protocol": { "worker": 1, "hostApi": 1, "relay": 1 },
  "bundle": {
    "id": "...",
    "generation": "...",
    "lockfileSha256": "...",
    "nodeAbi": "...",
    "electronAbi": "...",
    "platform": "darwin",
    "arch": "arm64",
    "overridesSha256": "...",
    "patches": [{ "path": "patches/node-pty@1.1.0.patch", "sha256": "..." }],
    "executionOwners": {
      "server/mcp-worker/entry.js": ["worker"],
      "server/qa-channel.js": ["server", "worker"]
    }
  },
  "dataCompatibility": { "reads": [1], "writes": 1, "rollbackReader": 1 },
  "files": [{ "path": "server/qa-channel.js", "size": 1, "sha256": "...", "mode": 420 }],
  "dynamic": {
    "threadEntrypoints": ["server/qa-report-thread.js"],
    "workerModules": [],
    "executables": ["bin/mcp/report.mjs"],
    "platformScripts": [],
    "assets": []
  }
}
```

`files`는 ESM·CJS 정적 그래프의 전체 파일을 담는다. `dynamic`은 `new Worker`, `workerData.module`,
`new URL`, `execFile`·`spawn`, 직접 파일 읽기로 찾는 대상을 담는다. `bin/mcp/report.mjs`, 플랫폼별
스크립트와 자료 파일을 빠뜨리지 않는다. 각 경로는 배포 루트 상대 경로이고 `..`와 심볼릭 링크를
허용하지 않는다. `.complete.json`은 manifest 해시와 전체 파일 해시 검증이 끝난 뒤 마지막에 쓴다.

<!-- 삭제·이름 변경 파일 판정에 쓰는 설치 당시 실행 주체 -->
<!-- 이번 설치가 만드는 기록부터 필수이며 이전 형식은 허용하지 않음 -->
`bundle.executionOwners`는 전체 설치 당시 실행 그래프에서 파일마다 확인한 실행 주체를 보존한다.
다음 설치 판정에서 사라진 파일은 이 기록으로 분류한다. worker 전용 파일의 삭제·이름 변경은 worker
교체로 처리하고 공유 파일이나 다른 실행 주체의 파일 삭제는 전체 설치로 처리한다.

`bundle` 값이 현재 설치 번들과 모두 같을 때만 번들의 `node_modules`를 링크한다. lockfile, ABI,
플랫폼·아키텍처, override 또는 patch가 다르면 worker 배포로 활성화하지 않고 전체 설치를 요구한다.

`current.json`은 다음 최소 필드를 갖는다.

```json
{
  "schemaVersion": 1,
  "deployId": "...",
  "previousDeployId": "...",
  "manifestSha256": "...",
  "bundleId": "...",
  "workerProtocol": 1,
  "activatedAt": "2026-11-01T08:00:00.000Z"
}
```

일반 activate는 새 worker가 `accepting`이 된 뒤에 임시 파일을 fsync하고 rename해 `current.json`을
바꾼다. 기록에 실패하면 새 worker를 retire한 뒤 이전 worker를 다시 실행한다. takeover recover의 기록
실패는 위 강제 복구 계약대로 새 worker를 current로 유지하고 실패를 보고한다.
공용 서버가 시작될 때 `current.json`, 실행 중 child pid, child의 deploy id와 manifest를 대조한다.
일치하지 않으면 요청을 받지 않고 `failed` 상태와 원인을 반환한다.

activate의 `expectPrevId`는 실행 중인 worker가 있으면 그 deploy id와 대조한다. 실행 중인 worker가
없으면 검증된 `current.json`을 이전 배포로 사용한다. takeover recover 뒤 pointer 기록만 실패해 둘이
다르면 실행 중인 worker를 유지하고 다음 같은 배포 활성화에서 `current.json`을 다시 기록한다.

전체 설치는 첫 실행에서 상태 폴더를 만든 뒤 잠금을 요청한다. 전체 설치와 worker 배포는 같은
`<상태 폴더>/deployment.lock`을 사용한다. worker 실행 독점은 별도의
`<상태 폴더>/mcp-worker/worker.lock`이 보장한다. 살아 있는 소유자의 잠금 파일을 삭제하지 않는다.
`expectPrevId`는 접수 중지 전에 검사하고, activation이 끝날 때 다시 확인한다. 배포 폴더는 고유 임시
폴더에 복사하고 검증한 뒤 rename한다. 정리는 현재, 직전 정상, 배포 중 폴더를 보존한다.

설치 판정은 변경 파일이 없어도 source bundle과 설치 bundle을 먼저 비교한다. lockfile, override,
patch, ABI, 플랫폼·아키텍처, `build.files`·`asarUnpack` 설정이 다르면 전체 설치다. `build.files`의
디렉터리 glob은 디렉터리 경계를 지킨다. 비교 후보에는 설치된 electron-builder `FileMatcher`의
기본 제외 규칙을 적용해 `.DS_Store`, `._*`, swap 파일처럼 패키지에 들어가지 않는 파일을 제외한다.
`package.json`은 설치된 electron-builder의 실제 변환 결과와 비교한다. `build.files`에 포함된 실행
파일을 모두 비교하며 실행 그래프에 없는 변경도 전체 설치로 분류한다. 저장소의 설치 명령에서만
실행하는 `scripts/mcp-worker/install.mjs`, `graph.mjs`, `index.mjs`는 설치 앱 안 사본을 실행하는 경로가
없으므로 이 비교에서 제외한다. `current.json`과 healthz의 실제 worker deploy id가 다르면 healthz의
값을 비교와 `expectPrevId` 기준으로 사용한다.

활성화 HTTP 상한은 drain·잠금 대기·기동 상한의 합보다 길다. 파일 변경이 없어도 healthz의
`accepting`과 `POST /browser-cmd`의 가벼운 `tabs` 요청 응답을 모두 확인한다. 실제 요청에 응답하지
않으면 recover로 분류한다. 일반 활성화의 `TIMEOUT`과 HTTP 상한 초과는 같은 설치 명령이
`recover: true`로 한 번 복구한다. 다른 활성화 실패도 healthz와 `tabs`를 다시 확인하고 요청을 받을
worker가 없으면 recover한 뒤 다시 확인한다. healthz의 worker가 접수 중이 아니면 파일 변경이 없어도
recover로 활성화한다. 명령
`pnpm install:app --recover`는 변경이 없어도 recover를 요청하며 worker 변경이 있으면 새 배포를
takeover로 활성화한다.

## 세션·회차 식별

식별값 전달 경로는 다음과 같다.

1. MCP 진입 프로세스가 `iris-session.mjs`의 resolver로 `session`을 정한다.
2. `iris-qa`가 stdio 연결별 `run`과 `key`를 요청에 넣는다.
3. 공용 서버 HTTP 경계가 로컬 요청, 필드 형식, 허용 크기를 확인하고 값을 바꾸지 않은 채 worker에
   전달한다.
4. worker가 run의 session 결속과 key hash를 확인한다.
5. worker가 host API를 호출하면 공용 서버가 탭·기기 owner와 session을 다시 확인한다.
6. Electron 중계가 필요한 경우 target token과 worker 세대를 추가한다. Electron에는 raw key를
   보내지 않는다.

`session`은 pane·Codex thread 등록·resume 정보와 조상 프로세스를 이용한 기존 resolver 결과다.
프로세스 id만으로 만들지 않는다. `run`은 QA 회차의 영속 식별값이다. `key`는 해당 stdio 연결이 run을
쓸 권한을 증명하는 비밀값이며 로그와 오류에 쓰지 않는다.

어느 프로세스에도 전역 "현재 세션", "현재 회차", "현재 key"를 두지 않는다. 같은 pane의 stdio
연결 둘도 서로 다른 key와 run을 요청마다 보낸다. key가 교체되면 이전 연결은 즉시 `KEY_DENIED`를
받는다. worker 교체 뒤 자동 복원은 유효한 기존 key를 요구한다. 새 key 발급은 명시적 `run_resume`에서
같은 session의 인수 조건을 다시 확인한 경우만 허용한다.

공용 서버 재시작으로 host의 run 결속과 key가 모두 사라진 경우에는 `run_resume` 한 요청만 임시
후보로 등록할 수 있다. worker가 회차 기록 첫 줄의 session이 요청 session과 같은지 확인해야 새 key로
결속한다. session이 다르거나 기록을 확인하지 못하면 `RUN_DENIED`로 끝내며 다른 host 연산에는 이
임시 권한을 적용하지 않는다.

상태 폴더의 `server.lock`, CDP 실행기 중복 등록 거부, 기존 세션 resolver를 유지한다.

## 승인 종류와 소유자

| 승인 | 소유자·저장 위치 | 교체 뒤 처리 | 유효 범위 |
| --- | --- | --- | --- |
| 실행기 lease grant | 공용 서버 메모리 | worker 교체 뒤 유지, 공용 서버 재기동 뒤 소실 | session, run, 실행기, 허용 명령, 만료 |
| 회차 승인 | `run_begin.charter.approvals`의 QA 기록 | 기록에서 복원 | run과 charter revision |
| 개별 로그인 승인 | worker의 회차 상태 | 회차 승인에서 다시 계산 | run, account id, origin, 로그인 단계 |
| 대량 입력 계획 | worker의 회차 상태와 journal | 계획 hash와 surface가 같을 때만 복원 | run, target surface, 필드 집합, 값 분류, formula 허용 여부 |

worker 메모리를 통째로 승인으로 복원하지 않는다. 회차 승인에서 허용되지 않은 로그인 항목은 다시
승인받는다. 대량 입력의 대상, 값 분류 또는 surface가 달라지면 이전 승인을 사용하지 않는다. 비밀번호
원문은 어느 승인 기록에도 쓰지 않는다.

## 데이터 호환 규칙

- worker 독립 배포는 현재 배포와 직전 정상 배포가 같은 QA 기록과 상태 파일을 읽을 수 있어야 한다.
- 기록 형식을 바꾸는 배포는 이전 형식 읽기를 같은 변경에 포함한다. append하는 JSONL은 기존 필드의
  뜻을 바꾸지 않고 새 필드를 선택적으로 추가한다.
- manifest의 `dataCompatibility.reads`, `writes`, `rollbackReader`가 현재 배포와 맞지 않으면 활성화를
  거부한다. 전체 설치로 분류하는 것만으로 데이터 호환 문제가 해결된 것으로 보지 않는다.
- 새 worker가 기록을 쓴 뒤 이전 worker로 돌아가 그 기록을 읽고 다음 기록을 추가하는 검사를 통과해야
  한다. 통과하지 못하는 변경은 자동 rollback 대상이 아니며 별도 이행과 복구 절차가 필요하다.
- journal seq, accepted·completed 짝, artifact 경로, QA ledger와 Electron anchor의 순서를 유지한다.
- `qaRevision`은 저장소 경로를 다시 읽어 버전을 추정하지 않는다. 실행 중인 bundle id와 worker
  deploy id를 기록하고, 기존 기록의 경로 기반 재검증은 계속 읽을 수 있게 한다.
- stdio 도구 schema가 바뀌면 worker만 배포하지 않는다. MCP 진입 코드는 저장소에서 직접 실행되므로
  `/mcp reconnect`가 필요한 변경으로 분류한다.

## 구현 확인 항목

- 공유 계약 모듈은 `qa-ownership`, `qa-journal`, `browser-runtime`, `browser-commands`를 전이적으로
  import하지 않는다.
- 다른 두 session, 같은 pane의 두 stdio 연결, 서로 다른 run, key 교체 뒤 이전 연결, worker 교체 직후
  동시 요청에서 소유권이 섞이지 않는다.
- 활성 관찰이 있으면 기본 교체를 거부하고 목록을 반환한다. 명시적 중단은 결과와 중단 기록을 남긴다.
- 열린 확인창, 파일 선택, 다운로드, 사용자 탭 이동, 개발 서버 실행 중 교체해도 공용 서버와 Electron
  pid가 유지된다.
- 이전 세대의 명령과 새 세대의 명령이 같은 탭에서 겹치지 않는다. 새 오류, 대상 오선택, 중복 입력은
  허용하지 않는다.
- 기능 동등성을 먼저 확인한 뒤 snapshot·click·qa-input 각 30회의 중앙값·p95·실패율을 비교한다.
  p95가 20% 넘게 늘면 해당 명령 이전을 중단한다.
