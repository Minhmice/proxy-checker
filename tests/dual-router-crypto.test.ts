import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sealSnapshot, openSnapshot } from "../src/server/backup/crypto-envelope.js";

test("crypto-envelope: roundtrip preserves UTF-8 string snapshot", () => {
  const key = crypto.randomBytes(32);
  const original = '{"nodes":[{"id":"node-1","quota":100}],"timestamp":1729680000}';
  const plaintext = new TextEncoder().encode(original);

  const envelope = sealSnapshot(plaintext, key);
  const decrypted = openSnapshot(envelope, key);

  assert.deepEqual(decrypted, plaintext);
  assert.equal(new TextDecoder().decode(decrypted), original);
});

test("crypto-envelope: roundtrip preserves binary data and empty buffer", () => {
  const key = crypto.randomBytes(32);

  const binaryPayload = crypto.randomBytes(4096);
  const encryptedBinary = sealSnapshot(binaryPayload, key);
  const decryptedBinary = openSnapshot(encryptedBinary, key);
  assert.deepEqual(decryptedBinary, new Uint8Array(binaryPayload));

  const emptyPayload = new Uint8Array(0);
  const encryptedEmpty = sealSnapshot(emptyPayload, key);
  assert.equal(encryptedEmpty.byteLength, 33);
  const decryptedEmpty = openSnapshot(encryptedEmpty, key);
  assert.equal(decryptedEmpty.byteLength, 0);
  assert.deepEqual(decryptedEmpty, emptyPayload);
});

test("crypto-envelope: output uses the existing AES-GCM wire format", () => {
  const key = crypto.randomBytes(32);
  for (const plaintext of [Buffer.alloc(0), crypto.randomBytes(4096)]) {
    const envelope = Buffer.from(sealSnapshot(plaintext, key));
    assert.equal(envelope.subarray(0, 4).toString("ascii"), "9RCE");
    assert.equal(envelope[4], 1);
    assert.equal(envelope.length, 33 + plaintext.length);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope.subarray(5, 17));
    decipher.setAuthTag(envelope.subarray(17, 33));
    assert.deepEqual(
      Buffer.concat([decipher.update(envelope.subarray(33)), decipher.final()]),
      plaintext,
    );
  }
});

test("crypto-envelope: random IV produces distinct ciphertexts for identical plaintext", () => {
  const key = crypto.randomBytes(32);
  const plaintext = new TextEncoder().encode("same-plaintext-payload");

  const env1 = sealSnapshot(plaintext, key);
  const env2 = sealSnapshot(plaintext, key);

  assert.notDeepEqual(env1, env2);

  assert.deepEqual(openSnapshot(env1, key), plaintext);
  assert.deepEqual(openSnapshot(env2, key), plaintext);
});

test("crypto-envelope: enforces exactly 32-byte key length", () => {
  const validPayload = new TextEncoder().encode("test");
  const validKey = crypto.randomBytes(32);
  const validEnvelope = sealSnapshot(validPayload, validKey);

  const invalidKeys = [
    new Uint8Array(0),
    new Uint8Array(16),
    new Uint8Array(31),
    new Uint8Array(33),
    new Uint8Array(64),
  ];

  for (const badKey of invalidKeys) {
    assert.throws(() => sealSnapshot(validPayload, badKey), /Invalid key length/);
    assert.throws(() => openSnapshot(validEnvelope, badKey), /Invalid key length/);
  }
});

test("crypto-envelope: wrong 32-byte key fails decryption", () => {
  const key1 = crypto.randomBytes(32);
  const key2 = crypto.randomBytes(32);
  const plaintext = new TextEncoder().encode("secret-data");

  const envelope = sealSnapshot(plaintext, key1);
  assert.throws(() => openSnapshot(envelope, key2), /Failed to decrypt envelope/);
});

test("crypto-envelope: tampered ciphertext throws error", () => {
  const key = crypto.randomBytes(32);
  const plaintext = new TextEncoder().encode("critical-system-backup-content");
  const envelope = sealSnapshot(plaintext, key);

  const tampered = new Uint8Array(envelope);
  tampered[tampered.length - 1] ^= 0x01;

  assert.throws(() => openSnapshot(tampered, key), /Failed to decrypt envelope/);
});

test("crypto-envelope: tampered auth tag throws error", () => {
  const key = crypto.randomBytes(32);
  const plaintext = new TextEncoder().encode("critical-system-backup-content");
  const envelope = sealSnapshot(plaintext, key);

  const tampered = new Uint8Array(envelope);
  tampered[20] ^= 0x01;

  assert.throws(() => openSnapshot(tampered, key), /Failed to decrypt envelope/);
});

test("crypto-envelope: tampered IV throws error", () => {
  const key = crypto.randomBytes(32);
  const plaintext = new TextEncoder().encode("critical-system-backup-content");
  const envelope = sealSnapshot(plaintext, key);

  const tampered = new Uint8Array(envelope);
  tampered[6] ^= 0x01;

  assert.throws(() => openSnapshot(tampered, key), /Failed to decrypt envelope/);
});

test("crypto-envelope: corrupted magic header throws error", () => {
  const key = crypto.randomBytes(32);
  const envelope = sealSnapshot(new TextEncoder().encode("hello"), key);

  const corruptedMagic = new Uint8Array(envelope);
  corruptedMagic[0] = 0x00;

  assert.throws(() => openSnapshot(corruptedMagic, key), /Invalid envelope magic header/);
});

test("crypto-envelope: unsupported version throws error", () => {
  const key = crypto.randomBytes(32);
  const envelope = sealSnapshot(new TextEncoder().encode("hello"), key);

  const unsupportedVer = new Uint8Array(envelope);
  unsupportedVer[4] = 0x02;

  assert.throws(() => openSnapshot(unsupportedVer, key), /Unsupported envelope version/);
});

test("crypto-envelope: truncated envelope throws error", () => {
  const key = crypto.randomBytes(32);
  const envelope = sealSnapshot(new TextEncoder().encode("hello"), key);

  const truncated = envelope.subarray(0, 32);
  assert.throws(() => openSnapshot(truncated, key), /Envelope truncated/);
});

test("crypto-envelope: plan specification contract verification", () => {
  const key = crypto.randomBytes(32);
  const secret = Buffer.from("credential-bearing snapshot");
  const first = sealSnapshot(secret, key);
  const second = sealSnapshot(secret, key);
  assert.deepEqual(Buffer.from(openSnapshot(first, key)), secret);
  assert.notDeepEqual(first, second);
  const damaged = Uint8Array.from(first);
  damaged[damaged.length - 1] ^= 0x01;
  assert.throws(() => openSnapshot(damaged, key));
});
