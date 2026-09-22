# Iris 디자인 토큰

메인 컬러 = Light Baby Blue. 하늘색 + 화이트의 쿨한 느낌. 색 변수는 두 층으로 규칙적으로 둔다.

## 1층 — 팔레트(raw hex, 지정값)

이름 규칙: `--pal-<계열>-<변형>`. 값은 지정된 hex 그대로. 역할이 아니라 "색 그 자체".

아래 표는 지정된 색이다. 1층에는 이것 말고 강도 변주로 파생한 것들(`--pal-ink-*`·
`--pal-paper-*`·`--pal-mist*`)과 상태색(`--pal-danger*`·`--pal-ok-2`)도 함께 포함된다.
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
| `--pal-tint-cool` | #E6F4F1 | 메인 돋보이게(쿨 화이트 배경) |
| `--pal-tint-warm` | #FCFCD4 | 메인 돋보이게(웜 배경, goldenrod) |

## 2층 — 시맨틱(역할, 팔레트/파생색을 참조)

이름 규칙: 기존 역할 토큰명 유지(`--bg`/`--fg`/`--card`/`--muted`/`--muted-fg`/`--accent`/`--primary`/`--primary-fg`/`--border`/`--input`/`--ring`/`--sidebar`/`--sidebar-accent`/`--sidebar-border`/`--success`/`--destructive`/`--ai`). 전 UI가 이 역할 토큰만 참조하므로 값만 쿨 팔레트로 매핑한다.

가독성이 필요한 곳(본문색·success/destructive 텍스트)은 팔레트 색의 강도 변주(진하게/옅게)를 파생해 쓴다. 좁은 팔레트 + 강도 변주가 "구분 장치"다(색 나열만으론 밋밋).

- 라이트: bg=옅은 스카이 화이트, card=화이트, primary=skype blue, ring=밝은 파랑, sidebar=베이비블루 틴트, border=sierra.
- 다크: 쿨한 블루-블랙 계열로 같은 역할 매핑(theme-aware).
- `--ai`(AI 제어 글로우)는 의도적으로 UI 블루와 구분되는 계열이다. 지금 값은 `--pal-pink`다. "지금 특별한 일이 일어남" 신호라 톤을 섞지 않는다.

포인트/상태 색(pop·pastel)은 작은 요소(배지·dot·칩)에만. 넓은 면적엔 메인/틴트/화이트만 써서 메인 컬러가 돋보이게.

## 테마 기본값
기본 = 다크. `:root`가 쿨한 블루-블랙 배경(`--pal-ink` #0A1620 계열) + `--primary`를 skype blue로
매핑해 Light Baby Blue 정체성을 다크에 실현한다. `:root { color-scheme: dark }`. 라이트(Light Baby Blue) 팔레트는
`:root[data-theme="light"]` opt-in으로 보존(나중에 토글 붙이면 재사용, 현재 토글 UI 없음). 구문색(.hl-*)도
다크 기본, 라이트는 data-theme=light일 때만. 터미널(우측)은 herdr ANSI라 다크(정합).
