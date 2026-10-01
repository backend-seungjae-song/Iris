# pane send: 사용자 입력 전달

세션 간 전달 경로는 둘이며, 각 경로가 처리하는 입력이 다르다.

`SendMessage` 는 LLM 간 메시지를 전달한다. 수신 모델이 메시지를 읽고 응답하며,
수신 측 하네스의 명령은 실행되지 않는다.

`pane send` 는 상대 세션의 입력창에 사용자 입력으로 글자를 넣고 Enter 를 누른다.
하네스가 처리하는 슬래시 명령은 이 경로로만 실행할 수 있다.

```
/compact
/mcp reconnect iris-mcp
/clear
/model
```

이 명령은 입력창에서 해석하며, LLM 이 도구로 호출할 수 없다. 사용자가 직접 입력하는 대신
세션 간에 이 명령을 실행하려면 `pane send` 를 사용한다.

## 연결

세션 그래프 화면의 UI 는 제거됐지만, 전송 경로는 유지한다.

```
브라우저/클라이언트
 ws.send({ type: "send", target: <paneId>, text: <보낼 글> })
 │
server/index.js msg.type === "send" → handleControl
 │
server/herdr-handlers.js 전송 권한·로컬 판정 뒤 herdr.agentSend(target, text)
 │ 그 뒤 400·1200·2600·5000ms 에 pane 을 읽어 되돌린다
server/herdr.js herdr 의 agent.prompt 호출
 │
herdr 대상 pane 에 사람 입력으로 넣는다
```

응답 유형은 다음과 같다.

| type | 의미 |
|---|---|
| `sent` | 전송 완료 |
| `pane` | 전송 후 수신 측 화면(네 차례 반환) |
| `control-error` | 전송 실패 |

`CONTROL_CAPS.send` 가 꺼져 있으면 전송을 거부한다. `ws._local` 로 원격 피어의 전송도
거부한다. 원격 피어가 로컬 AI 를 통해 원격 셸 금지를 우회하지 못하게 하기 위한 제한이다.

터미널에서는 herdr CLI 로 같은 입력을 전달한다.

```
herdr pane run <paneId> "/compact"
```

## 현재 세션의 /model 실행 절차

`/model` 은 입력 후 선택창에서 Enter 를 한 번 더 눌러야 확정된다. `/compact` 와 달리
명령 입력만으로 완료되지 않으므로 Enter 도 함께 전송한다.

 herdr pane run <paneId> "/model fable" && sleep 2 && herdr pane send-keys <paneId> enter

- 별칭만 지원한다. `opus`·`fable` 은 동작하지만 `claude-opus-5` 같은 전체 ID 에는 응답하지 않는다.
- 모델 전환은 턴을 중단하지 않는다. 이 호출 이후의 도구 호출부터 새 모델을 사용한다. `/compact` 의
 "그 턴의 마지막 도구 호출" 조건은 `/model` 에는 없다.
- 키 이름은 `enter` 다. 같은 명령에서 `backspace` 도 지원한다.
- 이전 모델로 돌아갈 때도 같은 형식으로 `"/model opus"` 를 전송한다.

서브에이전트의 권한 요청에도 같은 키로 응답한다. 부모 pane 에 표시된 프롬프트에서
`send-keys enter` 는 1번(Yes)을 선택한다. 파괴적 명령도 같은 키로 승인되므로,
먼저 `herdr pane read <paneId> --source visible` 로 요청 내용을 확인한 뒤 응답한다.
자동 승인은 구현하지 않는다.

## 세션 간 질문 전달 예시

세션 그래프의 「말 걸기」 UI 는 제거됐지만, 질문 전달 방식은 아래 예시와 같다. 사용자가
A 를 선택하고 B 에게 질문할 내용을 입력하면, A 의 입력창에 질문 전달을 요청하는 문장을 넣는다.

```js
// 보낼 내용. 지시문과 본문을 구분선으로 나눈다
function askText(targetSessionId, body) {
 return `세션 ID "${targetSessionId}"의 현재 pane을 확인하고 SendMessage로 아래를 물어봐 줘. 해당 세션이 없으면 다른 세션으로 대체하지 말고 알려줘. 답이 오면 정리해 줘.\n\n---\n${body}\n---`;
}

// 전송. 서버의 기존 제어 경로를 그대로 쓴다
let ws = null, wsReady = false;
function connectWS {
 ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
 ws.addEventListener("open", => { wsReady = true; });
 ws.addEventListener("close", => { wsReady = false; setTimeout(connectWS, 2000); });
 ws.addEventListener("message", (ev) => {
 const m = JSON.parse(ev.data);
 if (m.type === "control-error") showError(m.message);
 });
}
function sendTo(paneId, text) {
 if (!wsReady || !paneId || !text.trim) return;
 ws.send(JSON.stringify({ type: "send", target: paneId, text }));
}
```

세션 소켓에 직접 연결하지 않는다. 공식 경로가 아니므로 버전에 따라 호환되지 않을 수 있다.

## 대상 주소 확인 방법

알림 대상은 그 알림이 필요한 작업이나 자원 사용 조건으로 찾는다. 표시 이름, cwd,
`idle` 여부 중 하나만으로 수신자를 정하지 않는다. 다음 확인은 `SendMessage`와
`herdr pane run` 등 모든 세션 간 전송에 적용한다.

1. Task.md에 알림 시점과 대상 조건을 적는다. 예: `install:app 직전, Iris 앱이나
   에뮬레이터를 사용해 QA 중인 세션에 재시작을 알림`. 확인했던 이름은 참고로만 남긴다.
2. `ListAgents` 또는 `herdr agent list`에서 현재 후보를 찾는다. 기록된 세션이 없으면
   조건으로 다시 찾고 비슷한 이름으로 대체하지 않는다. 사용자가 특정 세션만 지정했다면
   다른 세션으로 바꾸기 전에 사용자에게 묻는다.
3. 후보의 현재 cwd와 실행 명령을 `herdr pane get <paneId>`와
   `herdr pane process-info --pane <paneId>`로 확인한다.
   `herdr pane read <paneId> --source recent --lines 80`으로 최근 작업도 확인한다.
   같은 프로젝트의 다른 작업이나 오래된 로그를 현재 자원 사용의 증거로 삼지 않는다.
   `idle` 상태여도 진행 중인 QA가 브라우저나 기기를 사용하고 있을 수 있다.
4. 조건에 맞는 수신자의 세션 ID, pane 주소, 확인 시각과 근거를 Task.md에 함께 기록한다.
   조건에 맞는 세션이 여럿이면 각각 확인한다. 도구 조회가 실패하거나 자원 사용 여부를
   판단할 수 없으면 전송을 보류하고 사용자에게 확인할 대상과 부족한 근거를 알린다.
5. 보내기 직전에 목록이나 `herdr agent get <주소>`를 다시 조회해 세션 ID와 pane의
   대응이 그대로인지 확인한다. 세션 ID를 제공하지 않는 도구라면 현재 터미널·프로세스
   식별자와 pane을 대조한다. 대응이 달라졌으면 2번부터 다시 확인한다.
   전송 도구가 받는 정확한 주소를 사용하고 표시 이름으로 보내지 않는다.
6. 전송 결과에 나온 수신 주소를 기록한 주소와 대조한다. 전송 결과가 불확실하면 실제
   수신 상태를 확인한 뒤 재시도한다. 전송 성공만으로 상대가 읽거나 동의했다고 판단하지 않는다.

기록 예시:

```text
알림 시점: install:app 직전
대상 조건: Iris 앱 또는 에뮬레이터를 사용해 QA 중인 세션
확인한 수신자: <session ID>, <pane ID>, <확인 시각>
근거: <현재 cwd>, <실행 명령>, <최근 출력에서 확인한 작업>
전송 결과: <실제 수신 주소와 성공·실패·미확인 상태>
```

`paneId` 는 herdr 이 할당한다. 요소 선택 모드에서 Spaces · Agents 목록의 세션 행을 누르면
해당 주소가 블록 형식으로 채팅에 추가된다(`web/js/browser/pick-host.js` 의 `deliverAgentPick`).

```
⟦Iris⟧ 세션 지목 · 판 만들기
주소: herdr pane w18:p1Q
…
보내기: herdr pane run w18:p1Q "<명령>"
⟦/Iris⟧
```

## 주의 사항

사용자 입력으로 전달되므로 수신 세션의 작업을 중단한다. 작업 중인 세션에 `/clear` 나 `/compact` 를
전송하면 해당 세션의 맥락이 사라진다. 사용자가 전송 내용과 대상을 확인하고 있을 때만 사용한다.
