# 제3자 구성 요소

이 저장소가 배포하거나 실행 시 함께 싣는 남의 코드와 그 조건을 모은다. 프로젝트 자체는
Apache-2.0(`LICENSE`)이고, 아래 항목들은 각자의 원래 라이선스를 그대로 유지한다.

## 이식한 코드

일부 파일은 새로 쓴 것이 아니라 다른 프로젝트에서 옮겨 온 것이다. 각 파일 머리에 출처를
적어 두었고, 여기서 한 번 더 모은다.

| 파일 | 원본 | 라이선스 |
| --- | --- | --- |
| `native/electron/snapshot-engine.cjs` | [Orca](https://github.com/stablyai/orca) `src/main/browser/snapshot-engine.ts` | MIT |
| `native/electron/cookie-import.cjs` | Orca `src/main/browser/browser-cookie-import.ts` | MIT |
| `native/electron/browser-hardening.cjs`, `native/electron/google-auth-user-agent.cjs` | Orca `browser-session-ua.ts`, `browser-google-auth-ua.ts`, 탐색 UA 정책 (`436ef827dda5941940a072b754ee3162aadcee1b`)을 Iris 수명주기에 맞게 적용 | MIT |
| `native/electron/cdp-control.cjs` | Orca의 CDP 제어 방식 | MIT |

이식하며 타입 제거·CJS 변환·macOS 환경 대응 등의 수정을 했다. Orca는 MIT이므로 재배포와
수정이 허용되며, 원 저작권 고지와 라이선스 전문은 아래에 그대로 둔다(이식한 revision
`436ef827`의 `LICENSE`와 현재 본문이 같다).

```text
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 화면 표시 (`web/vendor/`)

아래 넷은 저장소에 두지 않고 `pnpm build:vendor`가 의존성에서 그대로 만들어 낸다. `package.json`
이 범위로 적은 것(monaco-editor·JSZip)의 실제 설치 버전은 `pnpm-lock.yaml`이 고정한다.

| 구성 요소 | 버전 | 라이선스 |
| --- | --- | --- |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | 6.0.0 | MIT |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) | 0.11.0 | MIT |
| [monaco-editor](https://github.com/microsoft/monaco-editor) | 0.52.x | MIT |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.x | MIT 또는 GPL-3.0-or-later 중 선택. 이 프로젝트는 MIT를 택한다 |

`web/vendor/docx-editor-core.esm.js`와 함께 싣는 `harfbuzz.wasm`은 별도 번들이며, 그 안에
들어간 23개 패키지의 목록·저작권·라이선스 전문은 `web/vendor/docx-editor-core.NOTICE.md`에 있다
(Apache-2.0 3건, MIT 19건, Zlib 1건).

## 글꼴

| 글꼴 | 출처 | 라이선스 |
| --- | --- | --- |
| Geist Variable (`web/fonts/Geist-Variable.woff2`) | [vercel/geist-font](https://github.com/vercel/geist-font) | SIL Open Font License 1.1: 전문은 `web/fonts/OFL.txt` (Copyright 2024 The Geist Project Authors) |

## 다른 회사의 표장

화면이 어느 에이전트인지 보여 주려고 그 도구의 표장을 싣는다: `web/img/agents/gemini.png`,
`web/img/agents/antigravity.png`, 그리고 `web/js/core/glyphs.js`의 Claude·Codex(OpenAI) 마크.
이 표장들은 각 회사(Google, Anthropic, OpenAI)의 상표이며, 그 도구를 가리키는 용도로만 쓴다.
이 저장소의 Apache-2.0은 여기에 미치지 않고, 어느 회사도 이 프로젝트를 후원하거나 보증하지
않는다. 다른 용도로 쓰려면 각 회사의 상표 지침을 따른다.

## 실행에 필요한 외부 프로그램

| 프로그램 | 관계 | 비고 |
| --- | --- | --- |
| [herdr](https://herdr.dev) | 터미널·에이전트 세션의 원천. 별도 프로세스로 실행하고 유닉스 소켓으로 대화한다 | Apache-2.0 (homebrew-core `Formula/h/herdr.rb`). 이 저장소는 herdr 바이너리를 담지 않고 `scripts/setup.sh`가 각자 컴퓨터에 설치한다. 링크가 아니라 프로세스 간 통신이므로 herdr의 라이선스가 이 코드로 전파되지 않는다 |

## 런타임 의존성

앱 번들에 실제로 실리는 것은 `dependencies` 트리다(`devDependencies`는 electron-builder·
esbuild 등 만드는 도구라 나가지 않는다). 그 트리는 전부 허용형이며, 확인한 분포는 이렇다.

| 라이선스 | 패키지 수 | 비고 |
| --- | --- | --- |
| MIT | 99 | |
| ISC | 13 | |
| Apache-2.0 | 9 | `@docx-editor.dev/core`, `@docx-editor.dev/i18n`, `@puppeteer/browsers`, `chromium-bidi`, `crc-32`, `emf-converter`, `puppeteer-core`, `readdir-glob`, `webdriver-bidi-protocol` |
| BSD-3-Clause | 3 | `devtools-protocol`, `duplexer2`, `ieee754` |
| MIT 또는 GPL-3.0-or-later 중 선택 | 1 | `jszip`. 이 프로젝트는 MIT를 택한다 |
| MIT AND Zlib | 1 | `pako` |

`exceljs` 가 끌어오던 옛 `unzipper 0.10` 은 라이선스를 선언하지 않은 `buffers@0.1.1` 을 실었다.
`package.json` 의 `pnpm.overrides` 로 `unzipper` 를 0.12 로 고정해 그 사슬을 뺐다. 표는
그 상태의 것이다.

전체 목록과 각 라이선스는 언제든 다시 낼 수 있다: `pnpm licenses list --prod`(배포분),
`pnpm licenses list`(도구 포함).

측정: pnpm 9.12.2. 이때의 직접 의존성은 이것들이었다:
`@docx-editor.dev/core`, `@xterm/addon-fit`, `@xterm/xterm`, `exceljs`, `jszip`,
`monaco-editor`, `node-pty`, `puppeteer-core`, `tldts`, `ws`. 이 목록이 `package.json`과 어긋나면 위 표는 낡은 것이므로
smoke가 막는다(다시 재고 이 절과 목록을 함께 고칠 것).
