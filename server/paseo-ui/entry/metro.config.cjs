// Iris 빌드용 Metro 설정. Paseo 원래 설정(metro.config.paseo.cjs 로 이름만 바꿈)을 그대로 쓰고
// 서버 패키지 소스의 ".js" import 를 같은 이름의 ".ts" 로 풀어 줌
// - iris-chat-entry.tsx 가 Paseo 의 도구 호출 변환 함수(packages/server 소스)를 가져오기 때문
// - 서버 소스는 ESM 관례대로 "./x.js" 로 적고 실제 파일은 x.ts
// - 서버 소스의 node:crypto 는 브라우저용 sha1 대체(iris-node-crypto.js, 알림 카드 id 용)
const fs = require("node:fs");
const path = require("node:path");
const config = require("./metro.config.paseo.cjs");

const serverSrc = path.resolve(__dirname, "..", "server", "src") + path.sep;
const inner = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (context.originModulePath.startsWith(serverSrc) && moduleName === "node:crypto") {
    return { type: "sourceFile", filePath: path.join(__dirname, "iris-node-crypto.js") };
  }
  if (context.originModulePath.startsWith(serverSrc) && moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const ts = path.resolve(path.dirname(context.originModulePath), moduleName.replace(/\.js$/, ".ts"));
    if (fs.existsSync(ts)) return { type: "sourceFile", filePath: ts };
  }
  return inner(context, moduleName, platform);
};

module.exports = config;
