# Iris 디자인 토큰

메인 컬러 = Light Baby Blue. 하늘색 + 화이트의 쿨한 느낌. 색 변수는 두 층으로 규칙적으로 둔다.

## 1층 — 팔레트(raw hex, 지정값)

이름 규칙: `--pal-<계열>-<변형>`. 값은 지정된 hex 그대로. 역할이 아니라 "색 그 자체".

아래 표는 지정된 색이다. 1층에는 이것 말고 강도 변주로 파생한 것들(`--pal-ink-*`·
`--pal-paper-*`·`--pal-mist*`)과 상태색(`--pal-danger*`·`--pal-ok-2`·`--pal-yellow-ink`)도 함께 포함된다.
표가 1층 전체가 아니라는 뜻이다. 지금 값은 `web/css/00-tokens.css` 에 있다.

| 토큰 | hex | 성격 |
|---|---|---|
| `--pal-babyblue` | #A6DAF4 | 메인 |
| `--pal-skype` | #00AFF0 | 강조(선명한 스카이) |
| `--pal-sierra` | #BFDAF7 | 보조 서피스/보더 |
| `--pal-blue` | #00A6FB | 밝은 파랑(포인트) |
| `--pal-sky-pop` | #85E8F6 | 쨍한 작은 요소 |
| `--pal-cyan-pop` | #74F3E5 | 쨍한 작은 요소(청록) |
| `--pal-mint-pop` | #8BFBC2 | 쨍한 작은 요소(민트) |
| `--pal-green-pop` | #BCFD97 | 쨍한 작은 요소(연두) |
| `--pal-yellow-pop` | #F9F871 | 쨍한 작은 요소(연노랑) |
| `--pal-pink` | #F4A1A7 | 파스텔 핑크(상태/포인트) |
| `--pal-green` | #7EC699 | 파스텔 그린(상태/포인트) |
| `--pal-fg-2` | #C3D6E3 | 다크 보통 글자 |
| `--pal-faint` | #5E7B8E | 다크 흐린 글자 |
| `--pal-tint-cool` | #E6F4F1 | 메인 돋보이게(쿨 화이트 배경) |
| `--pal-tint-warm` | #FCFCD4 | 메인 돋보이게(웜 배경, goldenrod) |

## 2층 — 시맨틱(역할, 팔레트/파생색을 참조)

이름 규칙: 시안 역할 토큰은 `--app-bg`/`--chrome`/`--surface`/`--raised`/`--hover`/`--select`/`--select-fg`/`--fg`/`--fg-2`/`--muted`/`--faint`/`--line`/`--line-strong`/`--accent`/`--focus`/`--ai`/`--ok`이다. 글자·크기·모서리·움직임의 공통 이름은 `--fs`/`--fs-s`/`--fs-xs`/`--fs-h`/`--row`/`--pad`/`--r`/`--r-s`/`--t`/`--ease`/`--sans`/`--mono`다.

기본 다크 테마는 시안 `direction-a.css`의 역할과 값을 따른다.

- 배경: 앱 바탕 `--app-bg`, 크롬 `--chrome`, 본문 표면 `--surface`, 떠 있는 면과 입력 배경 `--raised`. 메뉴·팝오버처럼 떠 있는 면의 그림자는 시안 `.menu` 값인 `--menu-shadow` 하나만 쓴다.
- 터미널 본문: 바탕 `--pal-term-bg`, 글자 `--pal-term-fg`(팔레트 1층). xterm 테마가 이 값을 읽는다.
- 상태: 가리킴 `--hover`, 선택 `--select`와 `--select-fg`, 강조 `--accent`, 포커스 `--focus`.
- 글자와 선: `--fg`, `--fg-2`, `--muted`, `--faint`, `--line`, `--line-strong`.
- 상태색: AI 활동 `--ai`, 성공 `--ok`, 위험 `--pal-danger`.
- `--ai`(AI 제어 글로우)는 의도적으로 UI 블루와 구분되는 계열이다. 지금 값은 `--pal-pink`다. "지금 특별한 일이 일어남" 신호라 톤을 섞지 않는다.

포인트/상태 색(pop·pastel)은 작은 요소(배지·dot·칩)에만. 넓은 면적엔 메인/틴트/화이트만 써서 메인 컬러가 돋보이게.

편집기·docx·시트처럼 시안 밖 화면만 쓰는 단계(`--fs-md`, `--r-card`, `--t-quick` 등)는 `web/css/00-tokens.css`에 따로 남긴다. docx 엔진의 `--ring`과 이름이 겹치지 않도록 선택 윤곽선은 `--pick-ring`을 쓰며 값은 `--focus`다.

공용 컴포넌트 CSS는 `web/css/01c-components.css`(클래스 접두사 `cc-`), 커스텀 드롭다운 동작은 `web/js/core/dropdown.js`.

## 에이전트 상태 점

herdr 의 기본 상태 색은 서로 구분하기 어려워 Iris 가 상태 다섯을 따로 정한다. 판정과 이름은
`web/js/core/agent-state.js`, 색은 2층 토큰 `--st-*` 가 갖는다. 점을 그리는 곳(스페이스 줄·에이전트
줄·오른쪽 머리·창 번호 줄)은 모두 `10-sidebar.css` 의 `.dot` 규칙 하나를 쓰고, 창 번호 줄만 크기를 6px 로 줄인다.

| 상태 | herdr 값 | 토큰 | 다크 | 라이트 | 모양 |
|---|---|---|---|---|---|
| 작업 중 | working | `--st-working` | `--pal-mint-pop` | `--pal-ok-2` 70% + `--pal-ink-2` | 원 + 3px 고리(12%) |
| 작업 완료 | done | `--st-done` | `--accent` | `--pal-skype` 60% + `--pal-ink-2` | 원 |
| 비활성화 | idle · unknown | `--st-idle` | `--faint` | `--faint` | 속이 빈 원(1px 테두리) |
| 멈춤(답 대기) | blocked | `--st-blocked` | `--pal-danger` | `--pal-danger-2` 85% + `--pal-ink-2` | 네모 + 3px 고리(14%) |
| 질문 있음 | done · idle + question | `--st-question` | `--pal-yellow-pop` | `--pal-yellow-ink` | 마름모 |

점은 놓이는 모든 바탕(사이드바 줄·마우스 올림·선택 줄, 오른쪽 머리, 창 번호 줄과 그 선택 칸)에서
WCAG 1.4.11 비텍스트 대비 3:1 을 넘어야 한다. 가장 진한 바탕은 선택 줄(`--select`)이다. 라이트 테마에서
다크의 색은 이 기준에 못 미쳐 잉크와 섞은 값을 쓴다. 노랑은 잉크와 섞으면 녹색으로 보여 1층에 황토색
`--pal-yellow-ink` 를 따로 둔다. 색만으로 구분하지 않도록(1.4.1) 다섯 상태의 모양이 모두 다르고, 점은
`role="img"` 와 `aria-label` 로 상태 이름을 스크린리더에 알린다.

질문 있음은 herdr 에 없는 상태다. 서버(`server/agent-question.js`)가 done·idle 에이전트의 대화 기록 끝을
읽어, 마지막 에이전트 텍스트 답 뒤에 사용자 발화가 없고 그 답의 마지막 줄이 물음표로 끝나면
`question` 을 붙인다. 스페이스 줄은 스페이스 상태가 done·idle 이고 그 스페이스 에이전트 중 하나라도
질문을 남겼으면 질문 있음으로 그린다. 점에는 상태 이름을 툴팁(title)으로 단다.

## 테마 기본값
기본은 다크다. `:root`가 쿨한 블루-블랙 배경과 Skype Blue `--accent`를 정의한다. 라이트(Light Baby Blue) 팔레트는 `:root[data-theme="light"]`에서 같은 역할 이름으로 다시 정의한다. 현재 테마 토글 UI는 없다. 터미널은 herdr ANSI 색을 쓰므로 다크로 표시된다.
