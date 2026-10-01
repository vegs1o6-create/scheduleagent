import { describe, expect, it } from "vitest";
import { summarizeForecast } from "../src/weather";

const entry = (time: string, temp: number, six?: { symbol: string; mm: number }, one?: string) => ({
  time,
  data: {
    instant: { details: { air_temperature: temp } },
    ...(one ? { next_1_hours: { summary: { symbol_code: one } } } : {}),
    ...(six
      ? { next_6_hours: { summary: { symbol_code: six.symbol }, details: { precipitation_amount: six.mm } } }
      : {}),
  },
});

describe("værvarsel fra Yr", () => {
  it("lager én dag per lokal dato med min/maks, nedbør og symbol midt på dagen", () => {
    const forecast = {
      properties: {
        timeseries: [
          // Torsdag 1. okt (i dag, kl 12 lokal tid): formiddagen er passert
          entry("2026-10-01T10:00:00Z", 11.4, undefined, "cloudy"),
          entry("2026-10-01T12:00:00Z", 12.6, { symbol: "lightrain", mm: 1.2 }),
          entry("2026-10-01T18:00:00Z", 8.2, { symbol: "rain", mm: 2.4 }),
          // Fredag 2. okt
          entry("2026-10-02T00:00:00Z", 5.1, { symbol: "clearsky_night", mm: 0 }),
          entry("2026-10-02T06:00:00Z", 4.4, { symbol: "fair_day", mm: 0 }),
          entry("2026-10-02T12:00:00Z", 13.5, { symbol: "partlycloudy_day", mm: 0.3 }),
          entry("2026-10-02T18:00:00Z", 9, { symbol: "cloudy", mm: 0 }),
          // Utenfor de 2 dagene vi ber om
          entry("2026-10-03T12:00:00Z", 10, { symbol: "snow", mm: 5 }),
        ],
      },
    };
    const days = summarizeForecast(forecast, new Date("2026-10-01T10:00:00Z"), "Europe/Oslo", 2);
    expect(days).toEqual([
      { date: "2026-10-01", symbol: "lightrain", max: 13, min: 8, precipitation: 3.6 },
      { date: "2026-10-02", symbol: "partlycloudy_day", max: 14, min: 4, precipitation: 0.3 },
    ]);
  });

  it("tomt eller ødelagt svar gir ingen dager", () => {
    expect(summarizeForecast({}, new Date("2026-10-01T10:00:00Z"), "Europe/Oslo", 7)).toEqual([]);
  });
});
