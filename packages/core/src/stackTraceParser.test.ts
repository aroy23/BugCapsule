import { describe, expect, it } from "vitest";

import { extractFailureSummary, parseStackTrace } from "./stackTraceParser.js";

describe("stackTraceParser", () => {
  it("normalizes Vitest reporter markers before file paths", () => {
    const frames = parseStackTrace(" ❯ tests/export-missing-address.test.ts:7:63", "/repo");

    expect(frames).toEqual([
      {
        file: "tests/export-missing-address.test.ts",
        line: 7,
        column: 63,
        isUserCode: true
      }
    ]);
  });

  it("extracts concise failure summaries", () => {
    expect(extractFailureSummary("AssertionError: expected value\nTypeError: Cannot read properties of null")).toBe(
      "AssertionError: expected value"
    );
  });
});
