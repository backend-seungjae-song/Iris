import { execFile as execFileCallback } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import stateHomeModule from "../state-home.cjs";

const execFile = promisify(execFileCallback);
const { stateHome } = stateHomeModule;

const KEY_NAME = "gateway-key.pem";
const CERT_NAME = "gateway-cert.pem";

function samePublicKey(keyPem, certificate) {
  const privateKey = createPrivateKey(keyPem);
  const fromPrivate = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const fromCertificate = certificate.publicKey.export({ type: "spki", format: "der" });
  return fromPrivate.equals(fromCertificate);
}

async function readCertificatePair(remoteDir, io) {
  const keyFile = path.join(remoteDir, KEY_NAME);
  const certFile = path.join(remoteDir, CERT_NAME);
  let keyPem;
  let certPem;
  try {
    [keyPem, certPem] = await Promise.all([io.readFile(keyFile, "utf8"), io.readFile(certFile, "utf8")]);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const certificate = new X509Certificate(certPem);
  if (!samePublicKey(keyPem, certificate) || !certificate.verify(certificate.publicKey)) {
    throw new Error("gateway certificate pair is invalid");
  }
  await io.chmod(keyFile, 0o600);
  return {
    keyPem,
    certPem,
    certHash: createHash("sha256").update(certificate.raw).digest("hex"),
    keyFile,
    certFile,
  };
}

async function missingPairState(remoteDir, io) {
  const present = [];
  for (const name of [KEY_NAME, CERT_NAME]) {
    try {
      await io.stat(path.join(remoteDir, name));
      present.push(name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (present.length === 1) throw new Error("gateway certificate pair is incomplete");
  return present.length === 0;
}

export async function prepareGatewayCertificate(options = {}) {
  const io = options.fs || fs;
  const stateDir = options.stateDir || stateHome();
  const openssl = options.openssl || "/usr/bin/openssl";
  const run = options.execFile || execFile;
  const remoteDir = path.join(stateDir, "remote");
  await io.mkdir(remoteDir, { recursive: true, mode: 0o700 });
  const existing = await readCertificatePair(remoteDir, io);
  if (existing) return { ...existing, reused: true };
  await missingPairState(remoteDir, io);

  const suffix = randomBytes(12).toString("hex");
  const temporaryKey = path.join(remoteDir, `.gateway-key-${suffix}.pem`);
  const temporaryCert = path.join(remoteDir, `.gateway-cert-${suffix}.pem`);
  try {
    await run(openssl, [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-pkeyopt", "ec_param_enc:named_curve",
      "-nodes", "-sha256", "-days", "3650", "-subj", "/CN=Iris Remote",
      "-addext", "basicConstraints=critical,CA:FALSE",
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=serverAuth",
      "-keyout", temporaryKey, "-out", temporaryCert,
    ], { timeout: 10_000, maxBuffer: 64 * 1024 });
    await io.chmod(temporaryKey, 0o600);
    const [keyPem, certPem] = await Promise.all([
      io.readFile(temporaryKey, "utf8"),
      io.readFile(temporaryCert, "utf8"),
    ]);
    const certificate = new X509Certificate(certPem);
    if (!samePublicKey(keyPem, certificate) || !certificate.verify(certificate.publicKey)) {
      throw new Error("generated gateway certificate is invalid");
    }
    await io.link(temporaryKey, path.join(remoteDir, KEY_NAME));
    await io.link(temporaryCert, path.join(remoteDir, CERT_NAME));
  } finally {
    await Promise.all([
      io.unlink(temporaryKey).catch(() => {}),
      io.unlink(temporaryCert).catch(() => {}),
    ]);
  }
  const created = await readCertificatePair(remoteDir, io);
  if (!created) throw new Error("gateway certificate was not created");
  return { ...created, reused: false };
}
