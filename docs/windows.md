# Windows에서 설치하기

저장소를 clone한 뒤 `setup.cmd`를 실행하세요. 필요한 도구를 확인하고 의존성을 받아 Windows 앱을 빌드한 뒤 사용자 계정에 설치하고 Iris를 엽니다. 소스를 갱신한 뒤 같은 명령을 다시 실행하면 앱을 갱신합니다.

```powershell
git clone https://github.com/backend-seungjae-song/Iris.git
cd Iris
.\setup.cmd
```

Git과 Node.js 22 이상이 없으면 winget 설치를 제안합니다. pnpm은 corepack으로 활성화를 시도하고 실패하면 사용자 계정에 설치합니다. herdr는 SHA-256을 확인한 Windows 동봉본을 빌드 때 준비합니다. Claude Code와 Codex는 별도로 설치하고 로그인하세요. 설치된 CLI에는 동의를 받아 Iris MCP 도구와 세션 기록·지목 등록 훅을 등록합니다. Codex는 `/hooks`에서 새 훅을 신뢰해야 실행합니다.

`setup.cmd --check`는 준비 상태만 확인합니다. `setup.cmd --yes`는 설치와 에이전트 설정 질문에 동의한 것으로 처리합니다. 기존 사용자 훅은 보존하고 Iris 훅만 갱신합니다. JSON이 손상됐거나 같은 MCP 이름을 다른 서버가 사용하면 이유를 표시합니다. 로컬 빌드에는 코드 서명 인증서를 사용하지 않습니다.

소스에서 설치 파일만 만들려면 다음 명령을 실행하세요.

```powershell
pnpm install --frozen-lockfile
pnpm dist:win
```

`pnpm install:app`은 Windows에서 새 앱을 빌드한 뒤 실행 중인 앱의 정상 종료를 기다리고 사용자 계정에 설치합니다. 새 에이전트 연결을 추가하려면 `setup.cmd`를 실행하세요. macOS에서는 기존 설치 절차를 사용합니다.

현재 Windows 배포는 x64입니다. [herdr 공식 릴리스 목록](https://herdr.dev/latest.json)의 0.9.3에는 Windows x86_64 바이너리만 있으며 Windows ARM64 바이너리는 없습니다(2026-10-06 확인). Windows ARM64 전용 빌드와 x64 에뮬레이션 실행은 검증하지 않았습니다.

## 데이터 위치

| 항목 | 경로 |
|---|---|
| 앱 | `%LOCALAPPDATA%\Programs\Iris\Iris.exe` |
| 브라우저 프로필 | `%APPDATA%\Iris` |
| 사용자 상태 | `%USERPROFILE%\.iris` |
| 개발 상태 | `%USERPROFILE%\.iris-dev` |

개발 서버와 개발 앱은 전용 포트 4291과 전용 상태 폴더를 사용합니다. 다음 명령은 macOS와 Windows에서 같습니다.

```powershell
pnpm dev
# 별도 터미널에서 실행
pnpm dev:app
```

`pnpm app`도 개발 앱을 엽니다. `pnpm dev:seed`는 설치본 상태와 쿠키를 개발 환경으로 복사합니다. 개발 앱과 개발 서버를 종료한 뒤 사용하세요.

## 지원 범위와 검증

기존 Windows 설치·서버 기동·herdr 터미널·앱 종료는 Windows CI에서 확인했습니다. 이번 변경은 CI에 clone된 checkout의 setup 실행·업데이트 재실행·준비 확인, 실제 PowerShell 훅과 PNG/JPEG 변환, npm 자식 프로세스 종료, 설치본 인증서 생성, 정상 종료 뒤 `server.lock` 해제를 추가했습니다. 해당 CI 결과와 실제 Windows 화면 확인이 끝나기 전에는 기능 동등화 전체를 완료로 보지 않습니다.

현재 코드에는 Windows 네이티브 창·대화상자 조작, 외부 Chrome 열기·미러, Android 개별 음량, 셸별 에이전트 실행·복원과 로컬 UDP mDNS 발견을 구현했습니다. 휴대폰 원격 에이전트 연결은 localhost의 인증 토큰으로 확인하고 연결 정보 파일의 접근 권한을 현재 Windows 사용자로 제한합니다. Tailscale은 winget 설치와 Windows의 관리자 동의 화면을 사용합니다. 이 동작들의 Windows 런타임 검증은 CI와 실제 화면 확인이 남아 있습니다.

Windows의 pane 닫기는 Ctrl+Shift+W, 이름 변경은 F2, 페이지 새로고침은 Ctrl+R/F5, 앱 새로고침은 Ctrl+Shift+R입니다. 터미널 복사·붙여넣기는 Ctrl+Shift+C/V이며 선택 중 Ctrl+C와 Ctrl+V도 사용할 수 있습니다. Ctrl+S는 셸에 전달합니다. Iris 창 전환은 Ctrl+`와 Ctrl+Shift+`를 사용하고 Alt+Tab은 Windows가 처리합니다. 기능 레일 이동은 Ctrl+Shift+좌우 화살표입니다. 사용자별 변경값은 설정의 단축키 화면에서 확인하세요.

터미널에 파일을 놓으면 현재 PowerShell·cmd·POSIX 셸에 맞춰 경로를 인용합니다. cmd에서 `%`, `!`, 큰따옴표가 포함된 경로는 변수를 잘못 해석할 수 있어 입력하지 않고 PowerShell 사용을 안내합니다. 셸을 확인할 수 없거나 확인 중 pane이 바뀌면 입력하지 않습니다.

- iOS Simulator는 macOS와 Xcode가 필요해 Windows에서 로컬 실행할 수 없습니다. Android 에뮬레이터를 사용하세요.
- Chrome 쿠키 자동 이전은 Chrome의 App-Bound Encryption 보호 때문에 보장할 수 없습니다. 필요한 사이트에는 직접 로그인하세요.
- 외부 Chrome에서 로그인한 결과를 Iris로 가져오는 인증 쿠키 전달은 지원하지 않습니다.
- Windows Hello는 Chromium의 기본 Windows 인증 흐름을 사용하며 실제 기기의 확인이 필요합니다.
- 외부 프로세스 작업 폴더 확인은 같은 비트 수의 프로세스만 지원합니다. 확인할 수 없는 프로세스는 사용 여부를 알 수 없다고 표시합니다.
- Windows의 Codex 세션은 등록된 세션 ID와 명시적 resume을 지원합니다. 새 세션이 등록되기 전에 열린 파일 핸들로 세션을 추정하는 macOS용 대비 경로는 제공하지 않습니다.
- 가상 데스크톱은 발견한 창의 데스크톱 ID를 조회합니다. 다른 앱을 다른 데스크톱으로 옮기거나 다른 데스크톱으로 전환하는 동작은 제공하지 않습니다.
