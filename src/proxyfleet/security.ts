import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

function getMasterKey(salt: Buffer): Buffer {
  const secret = process.env.FLEET_ENCRYPTION_KEY || process.env.CONTROL_PASSWORD || "proxyfleet-default-fallback-master-key";
  return crypto.scryptSync(secret, salt, 32);
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  salt: string;
  tag: string;
}

export function encryptSecret(plaintext: string): EncryptedPayload {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getMasterKey(salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = getMasterKey(salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

export function generateRandomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function redactSecret(secret: string): string {
  if (!secret) return "";
  return "•".repeat(Math.min(12, Math.max(8, secret.length)));
}
