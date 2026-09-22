# 설정 참고

처음 설치한다면 [README](../README.md#설치하기)의 `./setup`을 사용하세요. 이 문서는 에이전트 연결을 직접 등록하거나 실행 환경을 바꿀 때 참고할 수 있습니다.

## 에이전트 연결

저장소 루트에서 사용하는 CLI에 맞는 명령을 실행하세요. 이미 `./setup`에서 등록했다면 다시 실행할 필요가 없습니다.

```bash
claude mcp add --scope user iris-mcp -- node "$PWD/bin/iris-mcp.mjs"
codex mcp add iris-mcp -- node "$PWD/bin/iris-mcp.mjs"
```

등록 경로에 있는 파일을 계속 사용하므로 저장소 폴더를 유지하세요. 폴더를 옮겼다면 `./setup`을 다시 실행해 연결 상태를 확인하세요.

연결을 해제하려면 해당 CLI의 명령을 실행합니다.

```bash
claude mcp remove iris-mcp -s user
codex mcp remove iris-mcp
```

`iris-agent-context` 스킬 파일은 `~/.claude/skills`와 `~/.codex/skills`에서 확인할 수 있습니다.

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
| `REMOTE=1` | `0.0.0.0`에서 수신하며 루프백과 `100.64.0.0/10`만 허용합니다. 별도 인증은 없습니다. [보안 안내](../SECURITY.md)를 확인하세요. |
| `HOST` | 바인딩 주소. `REMOTE`보다 우선합니다. |
| `CLAUDE_CONFIG_DIR` | Claude Code 홈. 기본값은 `~/.claude`입니다. |
| `CODEX_HOME` | Codex 홈. 기본값은 `~/.codex`입니다. |
| `IRIS_WEBVIEW_LRU=0` | 비활성 탭 절전 해제 |
| `IRIS_CRED_SHARE_PARTITIONS=1` | 다른 프로필의 저장 계정도 표시합니다. 기본값은 꺼짐입니다. |
| `IRIS_SERVER_NODE` | 서버용 Node 실행 파일 |
| `IRIS_SERVER_ROOT` | 앱에 포함된 소스 대신 사용할 서버 소스 위치 |

CLI나 MCP를 개발 환경에 연결할 때는 `IRIS_PORT=4291`과 `IRIS_STATE_DIR`를 함께 지정하세요. 명령과 환경 분리 조건은 [개발 환경 안내](two-flows.md)에 있습니다.
