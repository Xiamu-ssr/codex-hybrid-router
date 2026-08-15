import assert from "node:assert/strict";
import {
  AsyncLruCache,
  compactionCacheKey,
  latestNativeCompactionPrefix,
} from "../lib/native-compaction-cache.mjs";

const input = [
  { type: "message", role: "user", content: "old" },
  { type: "compaction", encrypted_content: "opaque" },
  { type: "message", role: "user", content: "new turn" },
  { type: "message", role: "assistant", content: "new answer" },
];
const prefix = latestNativeCompactionPrefix(
  input,
  (item) => item?.type === "compaction" && item.encrypted_content === "opaque",
);
assert.deepEqual(prefix, input.slice(0, 2));
assert.equal(compactionCacheKey(prefix), compactionCacheKey(input.slice(0, 2)));
assert.notEqual(compactionCacheKey(prefix), compactionCacheKey(input));

let calls = 0;
const cache = new AsyncLruCache(2);
const first = cache.getOrCreate("stable-prefix", async () => {
  calls += 1;
  await Promise.resolve();
  return "portable summary";
});
const second = cache.getOrCreate("stable-prefix", async () => {
  calls += 1;
  return "wrong";
});
assert.deepEqual(await first, { value: "portable summary", hit: false });
assert.deepEqual(await second, { value: "portable summary", hit: true });
assert.equal(calls, 1);

process.stdout.write("native_compaction_cache_ok\n");
