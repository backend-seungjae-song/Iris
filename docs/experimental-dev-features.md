# 선택 기능: 검색·알림·Git 작업

설정의 기능 목록에서 다음 기능을 각각 끌 수 있다. 통합 검색과 알림은 창을 다시 읽으면 모듈이 빠진다. Diff 의견·Worktree·GitHub PR은 앱을 다시 시작하면 서버 처리기까지 빠진다. 기존 Git 기능은 별도 `sourcecontrol` 항목으로 유지된다.

| 기능 | 등록 ID | 사용하는 위치 |
|---|---|---|
| 통합 검색 | `unifiedsearch` | 폴더 이름 오른쪽 검색 버튼 |
| 알림 | `notifications` | 검색 버튼 오른쪽 알림 버튼 |
| Diff 의견 | `diffreview` | 변경 내용의 줄 의견과 초안 전달 |
| Worktree | `worktrees` | 저장소별 스페이스·에이전트 목록과 관리 메뉴 |
| GitHub PR | `githubpr` | Git 브랜치 아래 PR 상태와 가운데 상세 탭 |

## 동작 범위

통합 검색은 스페이스·에이전트·열린 탭·스페이스 폴더의 파일 이름을 검색한다. 파일 내용 검색은 포함하지 않는다. 알림은 완료·질문·입력 대기를 표시한다. 처음 받은 상태의 기존 완료를 새 알림으로 만들지 않는다.

Diff 의견은 파일의 비교 종류와 patch를 함께 저장한다. 변경 내용이 달라지면 이전 의견을 별도로 표시한다. 같은 파일의 미해결 의견을 같은 스페이스의 Claude 또는 Codex 입력창에 초안으로 넣을 수 있다. 작업 중인 에이전트에는 넣지 않는다. Enter는 사용자가 누른다. 전송 결과가 불확실하면 다시 누르기 전에 대상 입력창을 확인한다. 의견 해결은 별도 조작이다.

Worktree는 기본 저장소 옆 `<저장소 이름>-worktrees` 폴더에 새 브랜치로 생성한다. 외부에서 만든 Worktree도 목록에서 열 수 있다. 삭제는 이 기능이나 아래 생성 명령이 만들고 기록의 폴더 식별값까지 일치하는 항목만 허용한다. 변경 파일·추적하지 않은 파일·무시한 파일·열린 스페이스·사용 중인 터미널이 있으면 삭제하지 않는다. 브랜치는 남긴다. 조작 응답이 없으면 해당 저장소의 추가 변경을 잠근다. Git 상태를 확인한 후 창을 다시 읽어 복구한다.

스페이스 아래에 Worktree를 두고 그 아래에 에이전트와 일반 터미널을 표시한다. 기본 작업 폴더는
「기본 워크트리」로, 추가 Worktree는 폴더 이름으로 표시한다. 각 Worktree의 `+`에서 빈 터미널,
Codex, Claude 세션을 해당 경로에 추가한다. 새 Worktree를 만들 때도 현재 스페이스에 터미널을
추가한다. `···`의 「표시 이름 바꾸기」는 폴더·브랜치를 변경하지 않으며 비우면 기본 이름으로 돌아간다.

여러 저장소의 Worktree가 같은 `.working/<작업>/[worktrees/]<저장소>` 아래에 있으면 한 작업으로
묶는다. 「저장소 N개」를 펼치면 각 경로와 브랜치를 확인하고 개별 저장소에 세션을 추가할 수 있다.
묶음의 `+`는 공통 작업 폴더에서 시작한다. 에이전트는 현재 작업 경로를 우선하고 작업 기록·실행 중
프로세스·만든 세션·사용 정보를 참고한다. 서로 다른 작업 묶음에 연결된 세션은 기본 그룹에 한 번
표시한다. 하위 에이전트는 부모 아래에 남는다. 일반 터미널은 pane 작업 경로로 분류한다.

삭제는 사용 여부를 확인한 항목에만 허용하고 서버가 다시 검사한다. 실행 중 판정은 목록을 요청할
때 herdr의 pane 정보와 `ps`·`lsof`로 계산한다. 3초 안의 목록 요청은 같은 조사 결과를 사용한다.

목록 응답은 기본 저장소의 현재 브랜치를 기준으로 각 Worktree의 앞선 커밋 수, 추가·삭제 줄 수, 커밋하지 않은 파일 수, 마지막 커밋 시각을 계산한다. Git 명령 하나라도 실패하면 변경량을 모름으로 두며, 같은 저장소를 여러 스페이스가 연 경우를 위해 경로별 결과를 10초 동안 함께 쓴다.

에이전트용 생성 명령은 `node <설치 앱>/Contents/Resources/app.asar.unpacked/bin/agent-context.mjs worktree --name 이름 [--base 기준 브랜치] [--branch 새 브랜치] [--repo 저장소]`이다. 기준 브랜치를 생략하면 지금 브랜치, 새 브랜치를 생략하면 `feat/<이름>`을 쓴다. herdr pane 안에서 실행하고 그 pane 셸이 이 프로세스의 조상이면 그 pane을 만든 세션으로 기록한다. 이 명령은 공유 소유 기록 파일에 쓰지 않고 worktree마다 만든 세션 기록을 남긴다. 서버는 폴더 식별값이 일치하는 그 기록을 소유 근거로 인정하므로 이렇게 만든 Worktree도 Iris에서 삭제할 수 있다.

폴더가 지워진 스페이스는 스페이스 행에 「폴더 없음」을 붙인다. 스페이스를 닫는 것은 사용자가 한다.

GitHub PR은 설치된 `gh`의 현재 인증을 사용한다. 대화·리뷰 의견·검사·변경 파일과 GitHub Actions 실패 로그를 읽는다. 조회 한도와 일부 조회 실패는 화면에 표시한다. PR 생성·병합·댓글 게시 기능은 없다. 로그와 의견은 선택한 로컬 에이전트의 입력창에 초안으로 넣는다.

## 파일 소유와 제거

| ID | 렌더러 | CSS | 서버 |
|---|---|---|---|
| `unifiedsearch` | `web/js/unified-search/` | `web/css/36-unified-search.css` | 없음 |
| `notifications` | `web/js/notifications/` | `web/css/37-notifications.css` | 없음 |
| `worktrees` | `web/js/worktrees/` | `web/css/38-worktrees.css` | `server/worktree-handlers.js` |
| `diffreview` | `web/js/diff-review/` | `web/css/39-diff-review.css` | `server/diff-review-handler.js` |
| `githubpr` | `web/js/github-pr/` | `web/css/40-github-pr.css` | `server/github-pr-handler.js` |

코드에서 제거할 때는 `web/js/core/capabilities.js`의 해당 항목, `web/index.html`의 해당 CSS 링크와 위 소유 파일을 함께 제거한다. 서버가 있는 기능은 `server/capabilities.js`의 항목과 import도 제거한다. `server/agent-draft.js`는 Diff 의견과 GitHub PR이 함께 쓰므로 두 기능을 모두 제거한 뒤 삭제한다. `test/`의 기능별 검사도 해당 범위에 맞게 정리한다.

호스트의 `diffreview.render`, `githubpr.branch`, `worktrees.*`, `unifiedsearch.tree`, `notifications.state` 호출은 제공자가 없으면 아무 동작도 하지 않는다. 다른 기능의 파일을 import하지 않는다. 헤더의 상태 원 위치는 기능 등록과 독립적이다.

## 남는 데이터

- 의견: 창의 `localStorage` 키 `iris.diffreview.v1`.
- 알림: 창의 `localStorage` 키 `iris.notifications.v1`.
- Worktree 소유 기록: `stateHome()` 아래 `worktree-ownership.json`. 생성한 Git Worktree와 브랜치는 기능을 꺼도 그대로 남는다.
- Worktree 표시 이름: `stateHome()` 아래 `worktree-labels/`. 경로와 폴더 식별값이 일치할 때만 적용한다.
- Worktree 만든 세션 기록: `stateHome()` 아래 `worktree-creators/`, Worktree마다 JSON 파일 하나. 폴더 식별값이 다르면 그 기록을 쓰지 않는다.

기능을 끄거나 코드를 제거해도 이 데이터를 자동 삭제하지 않는다. 소유 기록을 지우면 기존 Worktree는 이 기능의 삭제 대상으로 인정되지 않는다. Git에서 직접 확인하고 관리할 수 있다.
