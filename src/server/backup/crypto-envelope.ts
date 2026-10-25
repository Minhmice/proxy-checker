import crypto from "node:crypto";

const MAGIC = Buffer.from("9RCE", "ascii"); // 9Router Crypto Envelope
const VERSION = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HEADER_LENGTH = MAGIC.length + 1 + IV_LENGTH + TAG_LENGTH; // 4 + 1 + 12 + 16 = 33

function validateKey(key: Uint8Array): void {
  if (!key || key.byteLength !== KEY_LENGTH) {
    throw new Error(
      `Invalid key length: expected ${KEY_LENGTH} bytes, got ${key?.byteLength ?? 0}`,
    );
  }
}

/**
 * Seals snapshot plaintext into an authenticated encrypted envelope.
 * Envelope layout: MAGIC (4B) + VERSION (1B) + IV (12B) + TAG (16B) + CIPHERTEXT
 */
export function sealSnapshot(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  validateKey(key);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = Buffer.allocUnsafe(HEADER_LENGTH + ciphertext.length);
  MAGIC.copy(envelope, 0);
  envelope[4] = VERSION;
  iv.copy(envelope, 5);
  tag.copy(envelope, 5 + IV_LENGTH);
  ciphertext.copy(envelope, HEADER_LENGTH);

  // ponytail: return Buffer directly as Uint8Array subtype. No unnecessary array copy.
  return new Uint8Array(envelope.buffer, envelope.byteOffset, envelope.byteLength);
}

/**
 * Opens and verifies authenticated snapshot envelope.
 * Throws on invalid magic, version, key length, truncation, or auth tag failure.
 */
export function openSnapshot(envelope: Uint8Array, key: Uint8Array): Uint8Array {
  validateKey(key);

  if (!envelope || envelope.byteLength < HEADER_LENGTH) {
    throw new Error(
      `Envelope truncated: expected at least ${HEADER_LENGTH} bytes, got ${envelope?.byteLength ?? 0}`,
    );
  }

  const buf = Buffer.isBuffer(envelope)
    ? envelope
    : Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);

  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error("Invalid envelope magic header");
  }

  const version = buf[4];
  if (version !== VERSION) {
    throw new Error(`Unsupported envelope version: ${version}, expected ${VERSION}`);
  }

  const iv = buf.subarray(5, 5 + IV_LENGTH);
  const tag = buf.subarray(5 + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = buf.subarray(HEADER_LENGTH);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // ponytail: return Uint8Array view over decrypted Buffer without extra copy.
    return new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  } catch (err) {
    throw new Error(
      `Failed to decrypt envelope: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
