// Civil schedule slots: an IANA zone, weekday numbers (Sunday = 0), HH:MM.
// Repeated autumn minutes share one key; nonexistent spring minutes have no slot.
export interface DigestSchedule {
  times: string[];
  days: number[];
  skipQuiet: boolean;
}
export const DEFAULT_DIGEST: DigestSchedule = {
  times: ["09:00", "13:00", "18:00"],
  days: [1, 2, 3, 4, 5],
  skipQuiet: false,
};

export function digestSchedule(value: unknown): DigestSchedule | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<DigestSchedule>;
  if (
    !Array.isArray(v.times) ||
    v.times.length > 24 ||
    !v.times.every((t) => typeof t === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) ||
    !Array.isArray(v.days) ||
    !v.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ||
    (v.skipQuiet !== undefined && typeof v.skipQuiet !== "boolean")
  )
    return null;
  return { times: [...new Set(v.times)].sort(), days: [...new Set(v.days)].sort(), skipQuiet: v.skipQuiet ?? false };
}

export function digestSlots(
  schedule: DigestSchedule,
  zone: string,
  from: Date,
  until: Date,
): { key: string; at: Date; local: string }[] {
  if (from > until || !schedule.times.length) return [];
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const civil = (at: Date) => {
    const parts = fmt.formatToParts(at);
    const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === name)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  };
  const first = Date.parse(`${civil(from).slice(0, 10)}T00:00:00Z`);
  const last = Date.parse(`${civil(until).slice(0, 10)}T00:00:00Z`);
  const slots: ReturnType<typeof digestSlots> = [];
  for (let day = first; day <= last; day += 86_400_000) {
    if (!schedule.days.includes(new Date(day).getUTCDay())) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    for (const time of schedule.times) {
      const local = `${date}T${time}`;
      const target = Date.parse(`${local}:00Z`);
      const candidates: number[] = [];
      for (const delta of [-36, 0, 36]) {
        const sample = target + delta * 3_600_000;
        const offset = Date.parse(`${civil(new Date(sample))}:00Z`) - sample;
        const candidate = target - offset;
        if (civil(new Date(candidate)) === local) candidates.push(candidate);
      }
      // Use the first real occurrence. The key remains the same through a DST overlap.
      const at = Math.min(...candidates);
      if (Number.isFinite(at) && at >= from.getTime() && at <= until.getTime())
        slots.push({ key: `digest:${local}`, at: new Date(at), local });
    }
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}
