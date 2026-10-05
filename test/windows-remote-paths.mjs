import assert from "node:assert/strict";
import { test } from "node:test";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const originalPath = process.env.PATH;
const originalProgramFiles = process.env.ProgramFiles;

test("Windows Tailscale 경로·미디어 링크와 Mac 경로 동작", async () => {
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.ProgramFiles = "C:\\Program Files";
    process.env.PATH = 'D:\\Tools;"E:\\Command Tools"';
    const { findTailscaleExecutable } = await import("../server/remote/network.js?windows");
    const checked = [];
    assert.equal(await findTailscaleExecutable({ access: async (candidate) => {
      checked.push(candidate);
      if (candidate !== "E:\\Command Tools\\tailscale.exe") throw new Error("missing");
    } }), "E:\\Command Tools\\tailscale.exe");
    assert.deepEqual(checked, ["C:\\Program Files\\Tailscale\\tailscale.exe", "D:\\Tools\\tailscale.exe", "E:\\Command Tools\\tailscale.exe"]);
    await assert.rejects(findTailscaleExecutable({ access: async () => { throw new Error("missing"); } }), { code: "tailscale-cli-not-found" });
    const { mediaText } = await import("../server/remote/media-links.js");
    for (const input of [String.raw`C:\Users\test\shot.png`, String.raw`\\server\share\shot.pdf`, '`C:\\Users\\First Last\\shot.png`']) {
      const rendered = mediaText(input, { ref: "agent1" });
      assert.match(rendered, /\[PC 파일\]\(iris-media:[0-9a-f]{32}\)/);
      assert.ok(!rendered.includes("Users") && !rendered.includes("server"));
    }
    assert.equal(mediaText("https://example.com/a.png", { ref: "agent1" }), "https://example.com/a.png");
    Object.defineProperty(process, "platform", platform);
    const mac = await import("../server/remote/network.js?mac");
    if (process.platform !== "win32") {
      assert.equal(await mac.findTailscaleExecutable({ access: async () => {} }), "/opt/homebrew/bin/tailscale");
      assert.match(mediaText("`/Users/you/a.png`", { ref: "agent1" }), /\[Mac 파일\]/);
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = originalProgramFiles;
  }
});
