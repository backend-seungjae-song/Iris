import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";

import connectionVectors from "../server/remote/contract/connection-vectors.json" with { type: "json" };
import { connectionSignatureBytes } from "../server/remote/contract/connection.js";
import { canonicalBytes } from "../server/remote/contract/jcs.js";

test("연결 서명 정규화는 숫자·문자열·UTF-16 키 순서를 고정한다", () => {
  assert.equal(canonicalBytes({ z: 1, a: "line\n", value: 1e-7 }).toString(), '{"a":"line\\n","value":1e-7,"z":1}');
  assert.equal(canonicalBytes({ "😀": 1, "€": 2, "\r": 3 }).toString(), '{"\\r":3,"€":2,"😀":1}');
  assert.throws(() => canonicalBytes({ value: "\ud800" }), /surrogate/);
  assert.throws(() => canonicalBytes({ value: Number.NaN }), /유한한/);
});

test("연결 서명 벡터는 정상·필드별 변조·다른 키·DER 오류를 구분한다", () => {
  const publicKey = createPublicKey({ key: Buffer.from(connectionVectors.publicKeySpki, "base64"), format: "der", type: "spki" });
  const otherKey = createPublicKey({ key: Buffer.from(connectionVectors.otherPublicKeySpki, "base64"), format: "der", type: "spki" });
  const signature = Buffer.from(connectionVectors.derBase64, "base64");
  assert.doesNotThrow(() => connectionSignatureBytes(connectionVectors.target));
  assert.equal(canonicalBytes(connectionVectors.target).toString("utf8"), connectionVectors.canonical);
  assert.equal(verify("sha256", connectionSignatureBytes(connectionVectors.target), publicKey, signature), true);
  for (const mutation of connectionVectors.mutations) {
    const changed = { ...connectionVectors.target, [mutation.field]: mutation.value };
    let accepted = false;
    try {
      accepted = verify("sha256", connectionSignatureBytes(changed), publicKey, signature);
    } catch {}
    assert.equal(accepted, false, mutation.field);
  }
  assert.equal(verify("sha256", connectionSignatureBytes(connectionVectors.target), otherKey, signature), false);
  assert.equal(verify("sha256", connectionSignatureBytes(connectionVectors.target), publicKey,
    Buffer.from(connectionVectors.malformedDerBase64, "base64")), false);
});
