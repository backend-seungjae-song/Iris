import { privatePath } from "./windows-private.cjs";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes, webcrypto, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import stateHomeModule from "../state-home.cjs";

const execFile = promisify(execFileCallback);
const { stateHome } = stateHomeModule;

const KEY_NAME = "gateway-key.pem";
const CERT_NAME = "gateway-cert.pem";

function pem(label, der) {
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

async function createWindowsCertificatePair() {
  const [asn1js, { AttributeTypeAndValue, BasicConstraints, Certificate, CryptoEngine, Extension, ExtKeyUsage }] = await Promise.all([
    import("asn1js"), import("pkijs"),
  ]);
  const crypto = new CryptoEngine({ name: "node", crypto: webcrypto });
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const certificate = new Certificate();
  certificate.version = 2;
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 1;
  certificate.serialNumber = new asn1js.Integer({ valueHex: serial });
  for (const name of [certificate.issuer, certificate.subject]) {
    name.typesAndValues.push(new AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: "Iris Remote" }) }));
  }
  const now = new Date();
  certificate.notBefore.value = now;
  certificate.notAfter.value = new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000);
  const extension = (oid, critical, value) => new Extension({ extnID: oid, critical,
    extnValue: value.toSchema ? value.toSchema().toBER(false) : value.toBER(false) });
  certificate.extensions = [
    extension("2.5.29.19", true, new BasicConstraints({ cA: false })),
    extension("2.5.29.15", true, new asn1js.BitString({ valueHex: new Uint8Array([0x80]), unusedBits: 7 })),
    extension("2.5.29.37", false, new ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.1"] })),
  ];
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey, crypto);
  await certificate.sign(keys.privateKey, "SHA-256", crypto);
  return {
    keyPem: pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)),
    certPem: pem("CERTIFICATE", certificate.toSchema().toBER(false)),
  };
}

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
  const windows = (options.platform || process.platform) === "win32";
  const remoteDir = path.join(stateDir, "remote");
  await io.mkdir(remoteDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") privatePath(remoteDir);
  const existing = await readCertificatePair(remoteDir, io);
  if (existing) return { ...existing, reused: true };
  await missingPairState(remoteDir, io);

  const suffix = randomBytes(12).toString("hex");
  const temporaryKey = path.join(remoteDir, `.gateway-key-${suffix}.pem`);
  const temporaryCert = path.join(remoteDir, `.gateway-cert-${suffix}.pem`);
  try {
    if (windows) {
      const pair = await createWindowsCertificatePair();
      await io.writeFile(temporaryKey, pair.keyPem, { flag: "wx", mode: 0o600 });
      await io.writeFile(temporaryCert, pair.certPem, { flag: "wx", mode: 0o600 });
    } else await run(openssl, [
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
