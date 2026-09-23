# orca-emulator-pane vendor notice

`orca-emulator-pane.esm.js` 는 [stablyai/orca](https://github.com/stablyai/orca) 커밋 `841d06a9690c551ec8d4f70a72376632ffa3c2e5` 에서 React·Zustand·i18n 을 import 하지 않는 순수 로직 파일만 골라 `scripts/vendor-orca-emulator.mjs` 로 esbuild 번들한 것이다. 직접 고치지 않는다.

## 포함 원본 파일

- `src/renderer/src/components/emulator-pane/emulator-pane-types.ts`
- `src/renderer/src/components/emulator-pane/emulator-attach-target.ts`
- `src/renderer/src/components/emulator-pane/emulator-device-frame-layout.ts`
- `src/renderer/src/components/emulator-pane/emulator-device-row-mapping.ts`
- `src/renderer/src/components/emulator-pane/emulator-device-state.ts`
- `src/renderer/src/components/emulator-pane/emulator-keyboard-paste.ts`
- `src/renderer/src/components/emulator-pane/emulator-pane-error-message.ts`
- `src/renderer/src/components/emulator-pane/emulator-pane-session-view.ts`
- `src/renderer/src/components/emulator-pane/emulator-prelaunched-session.ts`
- `src/renderer/src/components/emulator-pane/emulator-screen-gesture.ts`
- `src/shared/emulator-touch-frame.ts`
- `src/shared/emulator-keyboard-frame.ts`

## 라이선스 (MIT, 원문)

```
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
