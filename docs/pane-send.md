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
server/herdr.js herdr 의 agent.send 호출
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
function askText(toName, body) {
 return `"${toName}" 세션에 SendMessage로 아래를 물어보고, 답이 오면 정리해서 알려줘.\n\n---\n${body}\n---`;
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

`paneId` 는 herdr 이 할당한다. 요소 선택 모드에서 AGENTS 목록의 세션 행을 누르면
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
