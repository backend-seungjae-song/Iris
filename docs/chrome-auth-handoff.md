# Chrome 로그인과 기본 기능

Iris는 탭·프로필·스페이스와 도킹을 관리하고, 브라우저 기능은 Electron과 Chrome의 공식 API를 사용한다.
내장 브라우저와 실제 Chrome은 같은 엔진 계열이지만, 로그인 공급자는 서로 다른 브라우저로 구분한다.

## 브라우저 식별 정보와 Google 로그인

일반 페이지는 현재 Electron 엔진의 UA와 Client Hints를 그대로 사용한다. 앱 이름 `Iris/…`만
일부 모바일 감지기의 오인을 막기 위해 제거한다. Chrome에서 가져온 쿠키의 출처 정보가 실행
엔진의 UA를 바꾸지는 않는다. `navigator`·권한 API·플러그인 목록을 가짜 객체로 바꾸지 않는다.

Google의 HTTPS 인증 호스트 `accounts.google.com`, `accounts.youtube.com`을 최상위 문서로
열 때 Orca의 호환 처리를 적용한다. 요청과 페이지는 Firefox 호환 UA를 사용하고 Chromium Client
Hints를 제거한다. 일반 문서 안의 인증 iframe이나 리소스 요청에는 URL만으로 이 호환 처리를
적용하지 않는다. 인증 문서의 다른 호스트 리소스 요청에도 같은 정합성을 유지한다. 인증 문서에서
다른 문서로 이동하면 원래 세션 또는 명시적 기기 미리보기의 UA로 돌아간다. 리다이렉트·기기 미리보기의 CDP override도
하나의 담당 모듈이 관리한다. 이 처리는 브라우저 엔진을 Firefox나 실제 Chrome으로 바꾸는 것이 아니다.

WebContents UA를 바꾸는 방식은 쓰지 않는다. 팝업의 첫 문서에 적용되지 않고, 로딩 중이면 POST
리다이렉트를 취소·재생할 수 있으며, `navigator.userAgentData.brands`와 하위 요청의 `sec-ch-ua`
헤더가 Chromium으로 남아 Firefox UA와 어긋난다. 따라서 인증용 UA는 탐색 시작과 리다이렉트에서
CDP `Emulation.setUserAgentOverride`에 `userAgent`만 실어 적용한다. 이 명령은 Client Hints를
비운다. 인증 호스트의 첫 main-frame 요청 헤더는 CDP 적용 여부와 무관하게 항상 Firefox로 바꾼다.
팝업의 생성·opener·세션 공유는 Electron의 기존 경로를 유지하며 다시 열거나 요청을 재생하지
않는다. 일반 사이트에는 이 명령을 위해 새 debugger를 연결하지 않는다.

Google의 `accounts.google.com/.../signin/rejected`는 세션 만료와 구분한다. 이 화면에서
자동으로 쿠키를 다시 넣고 새로고침하는 루프를 시작하지 않는다. 디버깅 설정·외부 창 전환을
로그인의 선행 절차로 추가하지 않는다. Google이 공개하지 않은 판정에 의존하는 호환 처리이므로
코드 검사와 실제 계정의 로그인·세션 유지 검증을 구분한다.

출처: Orca의 [Google 로그인 수정 #12884](https://github.com/stablyai/orca/pull/12884),
[엔진 기본 정체성 복원 #18749](https://github.com/stablyai/orca/pull/18749).
Google의 일반적인 제한은 [지원 브라우저 안내](https://support.google.com/accounts/answer/7675428)와
[브라우저 요구사항](https://developers.googleblog.com/guidance-to-developers-affected-by-our-effort-to-block-less-secure-browsers-and-applications/)에 있다.

## CDP 부착 정책

탭의 debugger(CDP)는 필요할 때만 붙이고 그 밖에는 떼어 둔다. 붙어 있는 debugger는 자동화 신호가
되어 로그인 공급자가 봇으로 판정하는 근거가 될 수 있기 때문이다. 탭을 만들거나 사람이 탐색하는
것만으로는 붙이지 않는다.

붙어 있는 조건은 다음 중 하나다.

- AI 명령이 그 탭에 들어온 뒤 30초 안. 명령마다 창을 다시 연다. 읽기 전용 명령도 CDP를 쓰므로
  같이 연장한다. 명령 단위로 떼면 스냅샷 ref가 매번 무효화되어 창을 둔다.
- 녹화나 요소 지목이 켜져 있다.
- 명시적 기기 미리보기가 켜져 있다.
- 대화상자 자동 응답 계획이나 파일 업로드 계획이 남아 있다.

떼는 조건은 다음 중 하나다. 뗄 때 스냅샷 ref는 무효화된다.

- 위 조건이 모두 사라지고 30초 창이 끝났다.
- 서버가 사람에게 넘겼다. `browser_ask_user`는 알림을 보내기 전에 네이티브 `handoff`를 보낸다.
- `login` 명령이 사람의 입력이 필요하다고 답했다.
- Google 인증 호스트로 들어갔다. 탐색 시작·리다이렉트·`goto` 인자 중 하나라도 그 호스트면 진입으로 본다.

Google 인증 호스트에서는 AI 세션을 붙이지 않는다. 남는 것은 위 절의 UA 적용을 위한 정체성 전용
debugger 하나다. 이 debugger는 UA override 한 명령만 보내며, 외부에서 떼면 다음 틱에 다시 붙인다.
인증 호스트를 떠나면 원래 UA를 되돌린 뒤 소유를 풀고 정책이 다시 판정한다. 그 호스트에 있는 동안
AI 명령은 CDP 없이 실행할 수 있는 부분집합(`goto url back forward reload wait text screenshot
login dialogs download nativewin nativekey nativeclick handoff`)만 허용하고, 나머지는 `cdp_blocked`
오류로 대안을 안내한다. 이 오류는 재부착 재시도를 하지 않는다.

사람이 쓰는 탭의 확인창 가로채기·패스키 알림·Turnstile 알림 스크립트는 CDP가 없을 때 프레임의
`dom-ready`에서 `executeJavaScript`로 주입한다. 문서 시작 전에 뜨는 대화상자는 네이티브 시트로
나온다.

## 기본 탐색과 도구 관찰

일반 탐색에서는 브라우저의 API를 다른 구현으로 대체하거나 Runtime 관찰을 상시 활성화하지 않는다.
Iris의 탭별 확인창, 파일 선택과 WebAuthn 알림에 필요한 문서 준비는 유지한다. 에이전트의 관찰·조작이나 요소 선택을
명시적으로 시작하면 콘솔·예외·네트워크 관찰을 활성화한다. 그 이전의 콘솔 기록을 수집했다고
가정하지 않는다. 교차 출처 프레임은 직접 조회하며 `Runtime.enable`을 일괄 전송하지 않는다.

## 전용 Chrome 미러와 세션 연결의 적용 범위

탭 메뉴의 ‘진짜 Chrome으로 열기’는 기존 전용 Chrome 미러를 바로 시작한다. 미러를 시작하기 전에
연결 방식 선택창을 표시하지 않는다. 전용 미러는 앱이 실행과 연결을 관리하며, 일반 사용자가 원격 디버깅
주소나 연결기를 설정하는 기능이 아니다. 전용 미러의 실행 동작이 복원돼도 Google 로그인 문제의
해결 여부는 별도로 확인해야 한다.

아래에서 설명하는 실행 중인 Chrome 세션 연결 기능은 일반 사용 흐름에 진입점을 제공하지 않는다.
이미 열린 연결의 종료·복귀 조작은 유지해 사용 중인 탭의 연결을 임의로 종료하지 않는다.

Chrome 144 이상은 `chrome://inspect/#remote-debugging`에서 사용자가 허용한 실행 중 세션에
연결하는 공식 경로를 제공한다. Iris는 `puppeteer-core`의 `connect({ channel: 'chrome' })`를 사용한다.
Chrome의 연결 승인이 필요하다. 사용자에게 이 승인을 반복해서 요청하는 설계는
일반 탐색의 수용 기준을 충족하지 못한다.

- Chrome을 별도 프로필로 실행하거나 종료하지 않는다. Chrome의 쿠키를 읽거나 Iris에 복제하지 않는다.
- Iris 기능에 노출하고 페이지 명령을 보내는 대상은 직접 만든 탭 ID로 제한한다. Puppeteer 자체의
  연결 초기화는 다른 target 메타데이터도 발견하며, 필터에서 제외한 tab을 잠시 연결·재개·해제할 수 있다.
  따라서 앱의 대상 제한을 Chrome 전체에 대한 디버깅 권한 제한으로 설명하지 않는다.
- 연결이 끊겨도 자동 재접속하지 않는다. 네이티브 인증으로 전환할 때에는 해당 탭을 앞으로 보이고
  연결을 끊는다. 인증을 끝낸 뒤 화면 연결은 사용자가 다시 요청한다.
- 현재 Chrome 기본 데이터 디렉터리에 대한 연결이다. 여러 Chrome 프로필을 Iris 파티션과 동일하게
  매핑한다고 가정하지 않는다.
- 연결 중인 브라우저를 거부하는 사이트에서는 Chrome 자체 화면에서 계속한다. 이 경로도 특정 사이트의
  Google/Cloudflare 통과를 보장하지는 않는다.

위 연결 경로는 전용 미러의 쿠키 seed나 프로세스 종료 코드를 사용하지 않는다.

새 탭은 browser target의 `Target.createTarget`으로 만들고 반환된 ID에만 연결한다. Puppeteer의
`newPage()`/`Page` 초기화를 사용하지 않아 해당 페이지의 `Runtime.enable`, 보조 JavaScript 실행
환경과 초기 스크립트 주입을 피한다. 페이지 화면과 사용자 입력을 전달하는 CDP 연결은 유지한다.
Chrome도 연결 중 자동화 제어 배너를 표시하므로 이 변경을 일반 Chrome과 구별 불가능하거나 Google
로그인 허용이 검증된 것으로 설명하지 않는다. 네이티브 인증·확장 팝업은 계속 Chrome 창에서 처리한다.

연결에는 기존 exact-target tunnel의 non-flat CDP 메시지를 사용한다. 이 프로토콜은 deprecated이므로
Chrome/Puppeteer 갱신 시 실제 연결·화면·입력·해제를 확인해야 한다.

근거: [Chrome 공식 세션 연결](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session),
[Puppeteer 연결 옵션](https://pptr.dev/api/puppeteer.connectoptions).

## 내장 브라우저의 패스키

Electron 43의 `app.configureWebAuthn`으로 macOS Touch ID를 설정한다. 빌드 서명 인증서의 Team ID와
앱 bundle ID로 Keychain access group을 구성한다. 해당 권한을 허용하는 유효한 Apple 프로비저닝
프로파일이 제공되고, 실행 파일의 실제 서명·entitlement가 일치할 때만 활성화한다. 프로파일이 없으면
제한 권한을 앱에 넣지 않으며 Chrome의 네이티브 인증 경로를 사용한다. 개발용 Electron이나 서명 조건이 맞지 않는 실행물은 기존 Chrome 인증 경로를 유지한다.
여러 자격증명이 반환되면 사용자가 계정을 선택한다.

이는 Iris에 등록한 기기 귀속 Touch ID 자격증명이다. Chrome이나 iCloud Keychain에 이미 등록된
패스키를 Iris가 공유한다고 가정하지 않는다. 해당 패스키는 Chrome에서 사용한다.

근거: [Electron WebAuthn 설정](https://www.electronjs.org/docs/latest/api/app#appconfigurewebauthnoptions-macos),
[계정 선택 이벤트](https://www.electronjs.org/docs/latest/api/session#event-select-webauthn-account).

## 기존 프로필 가져오기와 자동 복구

Chrome/Brave/Edge 프로필 선택, 쿠키 가져오기, 선택적 비밀번호 가져오기와 인증 후 Iris 복귀를 유지한다.
쿠키 복제는 실제 Chrome 세션을 그대로 사용하는 위 연결 경로와 다르다. 서버가 세션을 폐기하거나
기기에 귀속한 인증을 쿠키 복제만으로 복구할 수 있다고 가정하지 않는다.

탐색·탭 활성화 시 연결된 프로필을 확인하되, 쿠키별 만료 시각으로 최신 값을 골라 섞지 않는다.
소스와 대상의 로그인 지문 및 마지막 적용 출처를 비교하고 Iris에서 별도로 바뀐 로그인을 보존한다.
같은 소스를 반복 적용해 로그인 화면을 새로고침하는 루프를 막는다. Google의 브라우저 거절은 별도
상태로 처리한다. 같은 Chrome 계정을 여러 Iris 파티션에 가져와도 각 연결 기록을 유지한다.

쿠키 교체는 안정된 전체 읽기·사전 검증 후 진행한다. 적용 중 해당 범위 요청을 잠시 보류하고 실패하면
원래 스냅샷으로 복구한다. 교체 전 요청의 늦은 `Set-Cookie`가 새 상태를 덮지 않게 한다. 원래 대상에
귀속된 보안 쿠키를 보존하며, 실제 적용과 재시작 후 적용할 staging 결과를 구분한다.

인증 인계 시에는 연결한 실제 프로필의 일반 창을 연다. 사용자가 창을 닫은 뒤 현재 사이트 범위만
읽어 적용한다. Chrome 원본 DB에는 쓰지 않는다. URL·쿠키·패스키·비밀번호를 진단 로그에 남기지 않는다.
개발 userData와 단일 인스턴스 잠금을 쿠키 staging 모듈보다 먼저 고정한다.

## 관련 코드

| 경계 | 소유 파일 |
| --- | --- |
| 실제 Chrome 세션 연결 | `native/electron/live-chrome-backend.cjs`, `native/electron/live-chrome-ipc.cjs` |
| 페이지 화면·입력 | `web/js/browser/chrome-mirror-surface.js` |
| Touch ID 설정·서명 | `native/electron/webauthn-platform.cjs`, `scripts/prepare-webauthn-entitlements.cjs` |
| Google 인증 UA·정체성 debugger | `native/electron/google-auth-user-agent.cjs` |
| CDP 부착 정책·명령 관문 | `native/electron/cdp-attach-policy.cjs`, `native/electron/cdp-control.cjs`, `native/electron/cdp-session.cjs`, `native/electron/webview-lifecycle.cjs` |
| 기존 프로필 인증 | `native/electron/chrome-auth.cjs`, `native/electron/chrome-handoff-ipc.cjs` |
| 쿠키 읽기·원자적 적용 | `native/electron/cookie-import.cjs`, `native/electron/cookie-snapshot.cjs`, `native/electron/cookie-transfer.cjs` |
| 자동 복구 판단 | `native/electron/cookie-sync-policy.cjs` |
| 닫힌 탭 탐색 이력 | `native/electron/browser-navigation-history.cjs`, `server/browser-runtime.js` |
| 이동 중 목적지 표시 | `web/js/browser/navigation-feedback.js`, `web/js/browser/webview-factory.js` |
