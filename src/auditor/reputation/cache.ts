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
  private static readonly fileLocks = new Map<string, Promise<void>>();
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

  private sanitizeStore(parsed: unknown): CacheStore {
    const validStore: CacheStore = { asn: {}, reputation: {} };
    if (!parsed || typeof parsed !== "object") return validStore;

    const candidate = parsed as Partial<CacheStore>;
    for (const section of ["asn", "reputation"] as const) {
      const source = candidate[section];
      if (source && typeof source === "object") {
        for (const [ip, rawEntry] of Object.entries(source)) {
          if (
            rawEntry &&
            typeof rawEntry === "object" &&
            typeof (rawEntry as { expiresAt?: unknown }).expiresAt === "number" &&
            (rawEntry as { data?: unknown }).data !== undefined
          ) {
            validStore[section][ip] = rawEntry as CacheEntry<unknown>;
          }
        }
      }
    }
    return validStore;
  }

  private async loadFromFile(): Promise<void> {
    if (!this.filePath) return;
    try {
      const content = await readFile(this.filePath, "utf8");
      const sanitized = this.sanitizeStore(JSON.parse(content));
      this.inMemory.asn = { ...sanitized.asn, ...this.inMemory.asn };
      this.inMemory.reputation = { ...sanitized.reputation, ...this.inMemory.reputation };
    } catch {
      // corrupt or missing file: keep in-memory store intact
    }
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const previous = ReputationCache.fileLocks.get(this.filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const dir = path.dirname(this.filePath!);
      await mkdir(dir, { recursive: true });
      let merged: CacheStore = {
        asn: { ...this.inMemory.asn },
        reputation: { ...this.inMemory.reputation },
      };

      try {
        const onDiskContent = await readFile(this.filePath!, "utf8");
        const onDisk = this.sanitizeStore(JSON.parse(onDiskContent));
        merged = {
          asn: { ...onDisk.asn, ...this.inMemory.asn },
          reputation: { ...onDisk.reputation, ...this.inMemory.reputation },
        };
      } catch {
        // no readable file yet or corrupt file to overwrite
      }

      this.inMemory = merged;
      const tempFile = `${this.filePath!}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      await writeFile(tempFile, JSON.stringify(merged, null, 2), "utf8");
      await rename(tempFile, this.filePath!);
    });
    ReputationCache.fileLocks.set(this.filePath, current);
    try {
      await current;
    } finally {
      if (ReputationCache.fileLocks.get(this.filePath) === current) {
        ReputationCache.fileLocks.delete(this.filePath);
      }
    }
  }

  async get<T>(ip: string, section: "asn" | "reputation"): Promise<T | undefined> {
    await this.loadFromFile();
    const entry = this.inMemory[section][ip];
    if (!entry || typeof entry.expiresAt !== "number") return undefined;
    if (this.now() >= entry.expiresAt) {
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
