// assets/icon.svg 한 장에서 macOS .icns와 png 세트를 만든다.
// 래스터라이저를 따로 설치하지 않는다. 이미 있는 Electron(Chromium)이 같은 엔진으로 그린다.
// 투명 창에서 capturePage 하면 둥근 사각 바깥이 알파로 남는다(스크린샷으로는 안 되는 부분).
// 창은 한 번만 띄운다. 크기마다 창을 새로 만들면 두 번째부터 로드가 ERR_FAILED로 실패한다.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "assets");
const ICONSET = path.join(OUT, "icon.iconset");
const MASTER = path.join(OUT, "icon.png");

// .icns가 요구하는 이름과 크기. 각 논리 크기의 1x/2x를 모두 넣어야 Finder·Dock이 다 만족한다.
const SET = [
  [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"], [1024, "icon_512x512@2x.png"],
];

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(OUT, "icon.svg"), "utf8");
  const tmp = path.join(os.tmpdir(), `ac-icon-${process.pid}.html`);
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8"><style>
     html,body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}
   </style>${svg}`);

  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false,
    transparent: true, backgroundColor: "#00000000", useContentSize: true });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 200));   // 그라디언트·블러가 첫 프레임에 다 안 올라온다
  fs.writeFileSync(MASTER, (await win.webContents.capturePage()).toPNG());
  win.destroy();
  fs.rmSync(tmp, { force: true });

  // 화면 배율에 따라 캡처가 2048로 나올 수 있다. 픽셀 수는 sips로 고정한다(알파 보존).
  execFileSync("sips", ["-z", "1024", "1024", MASTER], { stdio: "ignore" });
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });
  for (const [size, name] of SET) {
    const p = path.join(ICONSET, name);
    fs.copyFileSync(MASTER, p);
    execFileSync("sips", ["-z", String(size), String(size), p], { stdio: "ignore" });
    process.stdout.write(`  ${name} (${size})\n`);
  }
  execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", path.join(OUT, "icon.icns")]);
  process.stdout.write("icon.icns 생성\n");
  app.exit(0);
});
