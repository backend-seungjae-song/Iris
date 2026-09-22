import assert from "node:assert/strict";
import { publicCommitDate } from "../scripts/public-commit-date.mjs";

const cases = [
  ["2026-09-22T23:59:59Z", "2026-09-23T08:59:59+09:00"],
  ["2026-09-23T00:00:00Z", "2026-09-23T00:00:00+09:00"],
  ["2026-09-23T09:59:59Z", "2026-09-23T00:00:00+09:00"],
  ["2026-09-23T10:00:00Z", "2026-09-23T19:00:00+09:00"],
  ["2026-12-31T15:00:00Z", "2027-01-01T00:00:00+09:00"],
];
for (const tz of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
  const previous = process.env.TZ;
  try {
    process.env.TZ = tz;
    for (const [input, expected] of cases) {
      assert.equal(publicCommitDate(new Date(input)), expected, `${tz}: ${input}`);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
assert.throws(() => publicCommitDate(new Date("invalid")), TypeError);
console.log("public-commit-date: 15 timezone/boundary cases passed");
