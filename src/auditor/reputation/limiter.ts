import type { ReputationProviderName } from "./provider.js";

interface BucketState {
  tokens: number;
  lastRefill: number;
}

export interface LimiterOptions {
  capacity?: number;
  refillPerSecond?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ProviderRateLimiter {
  private buckets = new Map<ReputationProviderName, BucketState>();
  private capacity: number;
  private refillPerSecond: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(options: LimiterOptions = {}) {
    this.capacity = options.capacity ?? 5;
    this.refillPerSecond = options.refillPerSecond ?? 2;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private getBucket(provider: ReputationProviderName): BucketState {
    let bucket = this.buckets.get(provider);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: this.now() };
      this.buckets.set(provider, bucket);
    }
    return bucket;
  }

  private refill(bucket: BucketState): void {
    const current = this.now();
    const elapsedSeconds = Math.max(0, (current - bucket.lastRefill) / 1000);
    if (elapsedSeconds > 0) {
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + elapsedSeconds * this.refillPerSecond
      );
      bucket.lastRefill = current;
    }
  }

  async acquire(provider: ReputationProviderName): Promise<void> {
    const bucket = this.getBucket(provider);
    while (true) {
      this.refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const needed = 1 - bucket.tokens;
      const waitMs = Math.max(1, Math.ceil((needed / this.refillPerSecond) * 1000));
      await this.sleep(waitMs);
    }
  }
}
