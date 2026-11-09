import assert from "node:assert/strict";
import { test } from "node:test";
import { daypartAt, mixColor, msUntilNextDaypart, parseSetting, resolveDaypart } from "./atmosphere.ts";

const at = (h: number, m = 0): Date => new Date(2026, 10, 9, h, m, 0, 0);

test("dayparts follow the local clock at every boundary", () => {
  const table: Array<[number, number, string]> = [
    [4, 59, "night"], [5, 0, "morning"], [10, 59, "morning"], [11, 0, "noon"], [15, 59, "noon"],
    [16, 0, "evening"], [18, 59, "evening"], [19, 0, "night"], [23, 59, "night"], [0, 0, "night"], [2, 30, "night"],
  ];
  for (const [h, m, want] of table) assert.equal(daypartAt(at(h, m)), want, `${h}:${m}`);
});

test("midnight stays night and the next change is the 05:00 sunrise on the next calendar day", () => {
  assert.equal(daypartAt(at(23, 59)), "night");
  assert.equal(daypartAt(new Date(2026, 10, 10, 0, 0)), "night");
  assert.equal(msUntilNextDaypart(at(23, 0)), 6 * 3600_000);
  assert.equal(msUntilNextDaypart(at(0, 30)), 4.5 * 3600_000);
  assert.equal(msUntilNextDaypart(at(10, 59)), 60_000);
  assert.equal(msUntilNextDaypart(at(18, 30)), 30 * 60_000);
});

test("automatic is the default and follows the clock; manual ignores it", () => {
  const fresh = parseSetting({});
  assert.deepEqual(fresh, { mode: "auto", manual: "morning" });
  assert.equal(resolveDaypart(fresh, at(20)), "night");
  const manual = parseSetting({ cafe_mode: "manual", cafe_theme: "evening" });
  for (const h of [3, 9, 13, 21]) assert.equal(resolveDaypart(manual, at(h)), "evening");
});

test("stored settings survive a restart and garbage falls back safely", () => {
  assert.deepEqual(parseSetting({ cafe_mode: "manual", cafe_theme: "night" }), { mode: "manual", manual: "night" });
  assert.deepEqual(parseSetting({ cafe_mode: "weird", cafe_theme: "dusk" }), { mode: "auto", manual: "morning" });
});

test("colour blending interpolates each channel", () => {
  assert.equal(mixColor(0x000000, 0xffffff, 0), 0x000000);
  assert.equal(mixColor(0x000000, 0xffffff, 1), 0xffffff);
  assert.equal(mixColor(0xff0000, 0x0000ff, 0.5), 0x800080);
  assert.equal(mixColor(0x102030, 0x102030, 0.7), 0x102030);
});
