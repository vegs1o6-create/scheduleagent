import { describe, expect, it } from "vitest";
import {
  addDays,
  buildDateContext,
  formatDateNo,
  isoWeek,
  mondayOfIsoWeek,
  resolveRelativeDate,
  todayIn,
  weekdayOf,
  zonedParts,
  zonedRfc3339,
  zonedToUtc,
} from "../src/dates";

const TZ = "Europe/Oslo";

describe("dagens dato i Europe/Oslo", () => {
  it("bruker Oslo-dato selv om UTC fortsatt er i går", () => {
    // 23:30 UTC 29.09 = 01:30 30.09 i Oslo (sommertid)
    expect(todayIn(new Date("2026-09-29T23:30:00Z"), TZ)).toBe("2026-09-30");
    // 22:59 UTC 31.12 = 23:59 i Oslo (vintertid) -> fortsatt nyttårsaften
    expect(todayIn(new Date("2026-12-31T22:59:00Z"), TZ)).toBe("2026-12-31");
    expect(todayIn(new Date("2026-12-31T23:00:00Z"), TZ)).toBe("2027-01-01");
  });

  it("gir riktig lokal time og ukedag", () => {
    const p = zonedParts(new Date("2026-10-04T16:00:00Z"), TZ);
    expect(p).toMatchObject({ date: "2026-10-04", hour: 18, weekday: 7 });
    const w = zonedParts(new Date("2026-11-01T17:00:00Z"), TZ);
    expect(w).toMatchObject({ date: "2026-11-01", hour: 18, weekday: 7 });
  });
});

describe("relative datoer", () => {
  const tuesday = "2026-09-29";
  it.each([
    ["i dag", "2026-09-29"],
    ["i morgen", "2026-09-30"],
    ["i overmorgen", "2026-10-01"],
    ["fredag", "2026-10-02"],
    ["på fredag", "2026-10-02"],
    ["tirsdag", "2026-10-06"], // i dag er tirsdag -> neste tirsdag
    ["mandag", "2026-10-05"],
    ["neste fredag", "2026-10-09"],
    ["fredag neste uke", "2026-10-09"],
    ["neste mandag", "2026-10-05"],
    ["torsdag denne uken", "2026-10-01"],
    ["om en uke", "2026-10-06"],
  ])("«%s» fra tirsdag 29.09.2026 = %s", (expr, expected) => {
    expect(resolveRelativeDate(expr, tuesday)).toBe(expected);
  });

  it("returnerer null for ukjente uttrykk", () => {
    expect(resolveRelativeDate("en gang i høst", tuesday)).toBeNull();
  });

  it("fungerer over månedsskifte og årsskifte", () => {
    expect(resolveRelativeDate("i morgen", "2026-12-31")).toBe("2027-01-01");
    expect(resolveRelativeDate("neste mandag", "2026-12-30")).toBe("2027-01-04");
    expect(resolveRelativeDate("i morgen", "2028-02-28")).toBe("2028-02-29"); // skuddår
  });

  it("lager datokontekst til prompten", () => {
    const ctx = buildDateContext(new Date("2026-09-29T10:00:00Z"), TZ);
    expect(ctx).toContain("I dag er tirsdag 29.09. 2026 (2026-09-29), ISO-uke 2026-W40");
    expect(ctx).toContain(`"i morgen" = 2026-09-30`);
    expect(ctx).toContain(`"neste fredag" / "fredag neste uke" = 2026-10-09`);
  });
});

describe("uker og kalenderdatoer", () => {
  it("ISO-uker", () => {
    expect(isoWeek("2026-09-29")).toBe("2026-W40");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(mondayOfIsoWeek("2026-W40")).toBe("2026-09-28");
    expect(mondayOfIsoWeek("2026-W01")).toBe("2025-12-29");
  });

  it("ukedager og formatering", () => {
    expect(weekdayOf("2026-09-29")).toBe(2);
    expect(weekdayOf("2026-10-04")).toBe(7);
    expect(formatDateNo("2026-10-02")).toBe("fredag 02.10.");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
  });
});

describe("tidssone og sommertid", () => {
  it("lager RFC3339 med riktig offset", () => {
    expect(zonedRfc3339("2026-09-29", "08:30", TZ)).toBe("2026-09-29T08:30:00+02:00");
    expect(zonedRfc3339("2026-12-01", "08:30", TZ)).toBe("2026-12-01T08:30:00+01:00");
  });

  it("håndterer dagene med overgang til/fra sommertid", () => {
    // 29. mars 2026: klokka stilles frem 02:00 -> 03:00
    expect(zonedRfc3339("2026-03-29", "12:00", TZ)).toBe("2026-03-29T12:00:00+02:00");
    expect(zonedRfc3339("2026-03-29", "01:00", TZ)).toBe("2026-03-29T01:00:00+01:00");
    // 25. oktober 2026: klokka stilles tilbake 03:00 -> 02:00
    expect(zonedRfc3339("2026-10-25", "12:00", TZ)).toBe("2026-10-25T12:00:00+01:00");
    expect(zonedToUtc("2026-10-25", "00:00", TZ).toISOString()).toBe("2026-10-24T22:00:00.000Z");
  });
});
