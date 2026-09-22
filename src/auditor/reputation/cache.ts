import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheEntry<T> {
  expiresAt: number;
  data: T;
}

interface CacheStore {
  asn: Record<string, CacheEntry<unknown>>;
  reputation: Record<string, CacheEntry<unknown>>;
}

export interface CacheOptions {
  filePath?: string;
  now?: () => number;
  asnTtlMs?: number;
  reputationTtlMs?: number;
}

export class ReputationCache {
  private inMemory: CacheStore = { asn: {}, reputation: {} };
  private filePath?: string;
  private now: () => number;
  private asnTtlMs: number;
  private reputationTtlMs: number;

  constructor(options: CacheOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.asnTtlMs = options.asnTtlMs ?? 24 * 60 * 60 * 1_000;
    this.reputationTtlMs = options.reputationTtlMs ?? 6 * 60 * 60 * 1_000;
  }

  private async loadFromFile(): Promise<void> {
    if (!this.filePath) return;
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as CacheStore;
      if (parsed && typeof parsed === "object") {
        this.inMemory.asn = parsed.asn && typeof parsed.asn === "object" ? parsed.asn : {};
        this.inMemory.reputation =
          parsed.reputation && typeof parsed.reputation === "object" ? parsed.reputation : {};
      }
    } catch {
      // corrupt or missing file: keep empty in-memory store
    }
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tempFile = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await writeFile(tempFile, JSON.stringify(this.inMemory, null, 2), "utf8");
    await rename(tempFile, this.filePath);
  }

  async get<T>(ip: string, section: "asn" | "reputation"): Promise<T | undefined> {
    await this.loadFromFile();
    const entry = this.inMemory[section][ip];
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      delete this.inMemory[section][ip];
      return undefined;
    }
    return entry.data as T;
  }

  async set<T>(ip: string, section: "asn" | "reputation", data: T): Promise<void> {
    const ttl = section === "asn" ? this.asnTtlMs : this.reputationTtlMs;
    this.inMemory[section][ip] = {
      expiresAt: this.now() + ttl,
      data,
    };
    try {
      await this.persist();
    } catch {
      // write failure never breaks in-memory lookup
    }
  }
}
