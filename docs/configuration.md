# 설정 참고

처음 설치한다면 [README](../README.md#설치하기)의 `./setup`을 사용하세요. 이 문서는 에이전트 연결을 직접 등록하거나 실행 환경을 바꿀 때 참고할 수 있습니다.

## 에이전트 연결

저장소 루트에서 사용하는 CLI에 맞는 명령을 실행하세요. 이미 `./setup`에서 등록했다면 다시 실행할 필요가 없습니다.

```bash
claude mcp add --scope user iris-mcp -- node "$PWD/bin/iris-mcp.mjs"
codex mcp add iris-mcp -- node "$PWD/bin/iris-mcp.mjs"
```

등록 경로에 있는 파일을 계속 사용하므로 저장소 폴더를 유지하세요. 폴더를 옮겼다면 `./setup`을 다시 실행해 연결 상태를 확인하세요.

브라우저 CLI와 MCP에서 탭을 열 때는 현재 대화 ID와 등록된 pane을 대조하고, 일치하는 등록이 없으면 호출 프로세스가 속한 pane을 확인합니다. 공유 Codex 서버가 물려받은 `HERDR_PANE_ID`는 다른 대화의 값일 수 있어 단독으로 사용하지 않습니다. 대화 등록도 프로세스 소유 정보도 없으면 탭을 열지 않습니다. herdr 밖에서 실행하는 위임 프로세스에는 확인한 부모 pane ID를 `IRIS_SESSION`으로 전달하세요. MCP 코드를 갱신했다면 MCP 연결을 다시 시작해야 반영됩니다.

연결을 해제하려면 해당 CLI의 명령을 실행합니다.

```bash
claude mcp remove iris-mcp -s user
codex mcp remove iris-mcp
```

`iris-agent-context` 스킬 파일은 `~/.claude/skills`와 `~/.codex/skills`에서 확인할 수 있습니다.

세션 기록·지목 등록 훅은 `~/.claude/settings.json`과 `~/.codex/hooks.json`의 `SessionStart`, `UserPromptSubmit` 항목 가운데 명령에 `IRIS_AGENT_CONTEXT_PROMPT_TARGETS=1`이 들어간 것입니다. 두 항목을 함께 지우면 해제됩니다. 설치 전 파일은 같은 폴더의 `.iris-agent-context.bak`에 있습니다.

## 저장 위치

| 항목 | 기본 위치 |
|---|---|
| 탭, 스페이스, 북마크, 메모, 보관, 로그인 허용 목록 | `~/.iris` |
| 브라우저 프로필 | `~/Library/Application Support/Iris` |
| 서버 로그 | 상태 폴더의 `server.log` |
| 개발용 상태 | `~/.iris-dev` |
| 개발용 브라우저 프로필 | `~/Library/Application Support/Iris-dev` |

## 환경변수

| 이름 | 용도 |
|---|---|
| `IRIS_PORT` | 서버 포트. 기본값은 `4271`입니다. |
| `IRIS_STATE_DIR` | 상태 폴더. 기본값은 `~/.iris`입니다. |
| `HERDR_BIN` | herdr 실행 파일 경로 |
| `REMOTE`, `HOST` | 더 이상 쓰지 않습니다. 지정해도 서버는 `127.0.0.1`에서만 접속을 받고 기동할 때 경고를 출력합니다. [보안 안내](../SECURITY.md)를 확인하세요. |
| `IRIS_ALLOWED_ORIGIN_HOSTS` | Origin 검사에서 더 받을 호스트 이름. 쉼표로 나눕니다. `http://<이름>:<서버 포트>` 와 스킴·호스트·포트까지 같아야 합니다. |
| `CLAUDE_CONFIG_DIR` | Claude Code 홈. 기본값은 `~/.claude`입니다. |
| `CODEX_HOME` | Codex 홈. 기본값은 `~/.codex`입니다. |
| `IRIS_WEBVIEW_LRU=0` | 비활성 탭 절전 해제 |
| `IRIS_CRED_SHARE_PARTITIONS=1` | 다른 프로필의 저장 계정도 표시합니다. 기본값은 꺼짐입니다. |
| `IRIS_SERVER_NODE` | 서버용 Node 실행 파일 |
| `IRIS_SERVER_ROOT` | 앱에 포함된 소스 대신 사용할 서버 소스 위치 |

CLI나 MCP를 개발 환경에 연결할 때는 `IRIS_PORT=4291`과 `IRIS_STATE_DIR`를 함께 지정하세요. 명령과 환경 분리 조건은 [개발 환경 안내](two-flows.md)에 있습니다.

## Windows 경로

Windows 설치·개발 명령은 [Windows 안내](windows.md)를 참고하세요. 브라우저 프로필은 `%APPDATA%\Iris`, 사용자 상태는 `%USERPROFILE%\.iris`에 저장합니다. 개발 환경은 포트 4291과 `%USERPROFILE%\.iris-dev`를 함께 지정합니다.
