import { createHash } from "node:crypto";

export function latestNativeCompactionPrefix(input, isNativeCompaction) {
  if (!Array.isArray(input) || typeof isNativeCompaction !== "function") {
    return null;
  }
  let lastNativeIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isNativeCompaction(input[index])) {
      lastNativeIndex = index;
      break;
    }
  }
  return lastNativeIndex < 0 ? null : input.slice(0, lastNativeIndex + 1);
}

export function compactionCacheKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AsyncLruCache {
  constructor(maxEntries = 64) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  async getOrCreate(key, factory) {
    if (this.entries.has(key)) {
      const pending = this.entries.get(key);
      this.entries.delete(key);
      this.entries.set(key, pending);
      return { value: await pending, hit: true };
    }

    const pending = Promise.resolve().then(factory);
    this.entries.set(key, pending);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    try {
      return { value: await pending, hit: false };
    } catch (error) {
      if (this.entries.get(key) === pending) this.entries.delete(key);
      throw error;
    }
  }
}
