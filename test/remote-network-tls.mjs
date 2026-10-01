import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareGatewayCertificate } from "../server/remote/certificate.js";
import { resolveTailscaleAddress } from "../server/remote/network.js";

test("Tailscale 실행 파일은 고정 후보 중 실행 가능한 첫 경로를 쓴다", async () => {
  const checked = [];
  const result = await resolveTailscaleAddress({
    candidates: ["/first", "/second", "/third"],
    async access(value) {
      checked.push(value);
      if (value !== "/second") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    execFile: async (file) => {
      assert.equal(file, "/second");
      return { stdout: "100.64.1.2\n" };
    },
    networkInterfaces: () => ({ tailscale0: [{ family: "IPv4", address: "100.64.1.2" }] }),
  });
  assert.equal(result.executable, "/second");
  assert.deepEqual(checked, ["/first", "/second"]);
  await assert.rejects(resolveTailscaleAddress({
    candidates: ["/missing"],
    access: async () => { throw new Error("missing"); },
    execFile: async () => ({ stdout: "" }),
    networkInterfaces: () => ({}),
  }),
    (error) => error.code === "tailscale-cli-not-found");
});

test("Tailscale IPv4는 CLI 결과와 이 Mac 인터페이스가 정확히 일치해야 한다", async () => {
  const result = await resolveTailscaleAddress({
    executable: "/tailscale",
    execFile: async (file, args) => {
      assert.equal(file, "/tailscale");
      assert.deepEqual(args, ["ip", "-4"]);
      return { stdout: "100.64.1.2\n" };
    },
    networkInterfaces: () => ({ tailscale0: [{ family: "IPv4", address: "100.64.1.2" }] }),
  });
  assert.deepEqual(result, { address: "100.64.1.2", executable: "/tailscale" });

  await assert.rejects(resolveTailscaleAddress({
    executable: "/tailscale", execFile: async () => ({ stdout: "100.64.1.3\n" }),
    networkInterfaces: () => ({ tailscale0: [{ family: "IPv4", address: "100.64.1.2" }] }),
  }), (error) => error.code === "tailscale-address-mismatch");
  await assert.rejects(resolveTailscaleAddress({
    executable: "/tailscale", execFile: async () => ({ stdout: "100.64.1.2\n100.64.1.3\n" }),
    networkInterfaces: () => ({}),
  }), (error) => error.code === "tailscale-address-unavailable");
});

test("게이트웨이 ECDSA 인증서는 상태 폴더에 0600 키로 생성하고 재사용한다", async (t) => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-cert-"));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  const first = await prepareGatewayCertificate({ stateDir });
  assert.equal(first.reused, false);
  assert.match(first.certHash, /^[0-9a-f]{64}$/);
  assert.equal((await fsp.stat(first.keyFile)).mode & 0o777, 0o600);
  const second = await prepareGatewayCertificate({ stateDir });
  assert.equal(second.reused, true);
  assert.equal(second.certHash, first.certHash);
  assert.equal(second.keyPem, first.keyPem);
  // Electron·Flutter 의 BoringSSL 은 명시 곡선 파라미터 키를 읽지 못함. 곡선 이름(prime256v1 OID) 필요
  const spki = new X509Certificate(first.certPem).publicKey.export({ type: "spki", format: "der" });
  assert.equal(spki.includes(Buffer.from("06082a8648ce3d030107", "hex")), true);
});

test("인증서 쌍 중 한 파일만 있으면 자동 교체하지 않는다", async (t) => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-cert-partial-"));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  const remoteDir = path.join(stateDir, "remote");
  await fsp.mkdir(remoteDir, { recursive: true });
  await fsp.writeFile(path.join(remoteDir, "gateway-key.pem"), "partial", { mode: 0o600 });
  await assert.rejects(prepareGatewayCertificate({ stateDir }), /incomplete/);
});
