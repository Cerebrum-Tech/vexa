/** The typed time field on the planned-meeting picker.
 *
 *  The slot list only speaks in quarter-hours, which made 17:35 — an ordinary meeting time —
 *  inexpressible, so users rounded their own calendar to fit the tool. These are the assertions for
 *  the field that fixed it: forgiving about how a time is written, strict about whether it is one.
 */
import { describe, it, expect } from "vitest";
import { parseTimeInput, formatTimeInput, nextHalfHour } from "../../ui-kit/DateTimePicker";

describe("parseTimeInput", () => {
  it("reads the separators people actually type", () => {
    for (const raw of ["17:35", "17.35", "17,35", "17 35"]) {
      expect(parseTimeInput(raw)).toEqual({ h: 17, m: 35 });
    }
  });

  it("does not require zero-padding", () => {
    expect(parseTimeInput("9:05")).toEqual({ h: 9, m: 5 });
    expect(parseTimeInput("09:05")).toEqual({ h: 9, m: 5 });
    expect(parseTimeInput("9:5")).toEqual({ h: 9, m: 5 });
  });

  it("reads a bare number the way a person means it", () => {
    expect(parseTimeInput("9")).toEqual({ h: 9, m: 0 });      // 09:00
    expect(parseTimeInput("930")).toEqual({ h: 9, m: 30 });   // 09:30
    expect(parseTimeInput("1735")).toEqual({ h: 17, m: 35 }); // 17:35
    expect(parseTimeInput("0905")).toEqual({ h: 9, m: 5 });
  });

  it("accepts the ends of the day", () => {
    expect(parseTimeInput("00:00")).toEqual({ h: 0, m: 0 });
    expect(parseTimeInput("23:59")).toEqual({ h: 23, m: 59 });
  });

  it("refuses an out-of-range time rather than clamping it", () => {
    // Silently turning 25:00 into 23:00 would schedule a meeting the user never asked for.
    for (const raw of ["24:00", "25:00", "17:60", "-1", "99"]) {
      expect(parseTimeInput(raw)).toBeNull();
    }
  });

  it("refuses what is not a time at all", () => {
    for (const raw of ["", "   ", "abc", "17:", ":", "::", "12345", "1:2:3"]) {
      expect(parseTimeInput(raw)).toBeNull();
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseTimeInput("  17:35  ")).toEqual({ h: 17, m: 35 });
  });

  it("round-trips through the field's own formatter", () => {
    const d = new Date(2026, 8, 8, 17, 35);
    expect(formatTimeInput(d)).toBe("17:35");
    expect(parseTimeInput(formatTimeInput(d))).toEqual({ h: 17, m: 35 });
  });

  it("expresses a minute the slot list cannot", () => {
    const parsed = parseTimeInput("17:35")!;
    expect(parsed.m % 15).not.toBe(0);   // the whole point of the field
  });
});

describe("nextHalfHour", () => {
  it("rounds up to the next quarter, which is what the default plan time uses", () => {
    expect(formatTimeInput(nextHalfHour(new Date(2026, 8, 8, 9, 1)))).toBe("09:15");
    expect(formatTimeInput(nextHalfHour(new Date(2026, 8, 8, 9, 16)))).toBe("09:30");
    expect(formatTimeInput(nextHalfHour(new Date(2026, 8, 8, 9, 46)))).toBe("10:00");
  });
});
