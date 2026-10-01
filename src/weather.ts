import { addDays, todayIn, zonedParts } from "./dates";
import { log } from "./log";

/** Én dag i værvarselet på infoskjermen. */
export interface WeatherDay {
  date: string;
  /** Yr-symbol, f.eks. "partlycloudy_day" eller "lightrain". */
  symbol: string | null;
  max: number | null;
  min: number | null;
  /** Nedbør i mm for dagen (avrundet til én desimal). */
  precipitation: number;
}

interface Forecast {
  properties?: {
    timeseries?: {
      time: string;
      data: {
        instant?: { details?: { air_temperature?: number } };
        next_1_hours?: { summary?: { symbol_code?: string } };
        next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
      };
    }[];
  };
}

/**
 * Gjør Yr-varselet om til én oppsummering per dag (lokal tid):
 * - min/maks av temperaturen gjennom dagen
 * - nedbør: summen av 6-timersblokkene som starter 00/06/12/18 UTC
 * - symbol: 6-timersblokken som starter 12 UTC (midt på dagen), ellers den første som finnes
 */
export function summarizeForecast(forecast: Forecast, now: Date, timeZone: string, days: number): WeatherDay[] {
  const today = todayIn(now, timeZone);
  const out = new Map<string, WeatherDay & { symbolHour: number }>();
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    out.set(date, { date, symbol: null, max: null, min: null, precipitation: 0, symbolHour: -1 });
  }
  for (const entry of forecast.properties?.timeseries ?? []) {
    const at = new Date(entry.time);
    const day = out.get(zonedParts(at, timeZone).date);
    if (!day) continue;
    const temp = entry.data.instant?.details?.air_temperature;
    if (typeof temp === "number") {
      day.max = day.max === null ? temp : Math.max(day.max, temp);
      day.min = day.min === null ? temp : Math.min(day.min, temp);
    }
    const six = entry.data.next_6_hours;
    const utcHour = at.getUTCHours();
    if (six && utcHour % 6 === 0) {
      day.precipitation += six.details?.precipitation_amount ?? 0;
      // 12 UTC er best; ellers den første blokken vi har (i dag kan formiddagen være passert).
      const code = six.summary?.symbol_code;
      if (code && (utcHour === 12 || day.symbolHour === -1)) {
        day.symbol = code;
        day.symbolHour = utcHour;
      }
    }
    if (!day.symbol && entry.data.next_1_hours?.summary?.symbol_code) {
      day.symbol = entry.data.next_1_hours.summary.symbol_code;
    }
  }
  return [...out.values()]
    .filter((d) => d.max !== null)
    .map(({ symbolHour: _, ...d }) => ({
      ...d,
      max: d.max === null ? null : Math.round(d.max),
      min: d.min === null ? null : Math.round(d.min),
      precipitation: Math.round(d.precipitation * 10) / 10,
    }));
}

/**
 * Henter varselet fra MET Norway (samme data som Yr). Vilkårene krever en
 * User-Agent som identifiserer appen, maks 4 desimaler og caching; svaret
 * caches derfor i Cloudflare i 30 minutter.
 */
export async function fetchWeather(lat: string, lon: string, now: Date, timeZone: string, days: number): Promise<WeatherDay[] | null> {
  const round = (v: string) => Number(Number(v).toFixed(4));
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${round(lat)}&lon=${round(lon)}`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "familiebot/1.0 github.com/vegs1o6-create/scheduleagent" },
      cf: { cacheTtl: 1800, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) {
      log("weather_failed", { status: res.status });
      return null;
    }
    return summarizeForecast((await res.json()) as Forecast, now, timeZone, days);
  } catch (err) {
    log("weather_failed", { error: String(err) });
    return null;
  }
}
