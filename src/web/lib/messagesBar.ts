import type { CSSProperties } from "react";

/**
 * Usage bars fill as things are USED (empty at the start, full when used up), and change colour gradually:
 * green → orange near the end → red when used up.
 */
export function usageColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  // hue 142 (green) at 0% → 32 (orange) at 75% → 0 (red) at 100%
  const hue = p <= 75 ? 142 - (110 * p) / 75 : 32 - (32 * (p - 75)) / 25;
  return `hsl(${Math.round(hue)} 75% 45%)`;
}

/** The filled part: its length is the share used; it runs from green (start) to the colour of the current level. */
export function usageBarStyle(pct: number): CSSProperties {
  const p = Math.max(0, Math.min(100, pct));
  // Stops at the same levels as the scale (yellow at half, orange at three quarters) so it never turns muddy.
  const stops = [`${usageColor(0)} 0%`];
  for (const at of [50, 75]) if (p > at) stops.push(`${usageColor(at)} ${Math.round((at / p) * 100)}%`);
  stops.push(`${usageColor(p)} 100%`);
  return { width: `${p > 0 ? Math.max(2, p) : 0}%`, background: `linear-gradient(to left, ${stops.join(", ")})` };
}

/**
 * The messages of a cycle as a usage bar, measured against the plan's own messages (or the total when messages were
 * added): messages taken off show as a fuller bar.
 */
export function messagesUsed(used: number, limit: number | null, planLimit?: number | null): { pct: number; style: CSSProperties } {
  if (limit === null) return { pct: 0, style: usageBarStyle(0) };
  const base = Math.max(limit, planLimit ?? 0);
  const left = base <= 0 ? 0 : Math.max(0, Math.min(100, ((limit - used) / base) * 100));
  const pct = 100 - left;
  return { pct, style: usageBarStyle(pct) };
}

export function extraNote(extra: number): string | null {
  if (!extra) return null;
  const n = Math.abs(extra).toLocaleString("en-US");
  return extra > 0 ? `منها ${n} إضافية` : `تم خصم ${n}`;
}

const DAY = 86_400_000;

/**
 * Days left of a subscription as a usage bar: the time used of a month (30 days) fills it (15 days left = half,
 * more than a month ahead = empty, ended = full and red).
 */
export function subscriptionLeft(expiresAt: number | null, now = Date.now()): { active: boolean; daysLeft: number; pct: number; label: string; tone: string; style: CSSProperties } {
  const active = !!expiresAt && expiresAt > now;
  const daysLeft = active ? Math.ceil((expiresAt! - now) / DAY) : 0;
  const pct = active ? Math.max(0, Math.min(100, Math.round(100 - ((expiresAt! - now) / (30 * DAY)) * 100))) : 100;
  const label = !expiresAt ? "لا يوجد اشتراك" : active ? `باقي ${daysLeft} ${daysLeft === 1 ? "يوم" : daysLeft <= 10 ? "أيام" : "يوم"}` : "منتهي";
  const tone = !active || daysLeft <= 3 ? "text-red-600" : daysLeft <= 7 ? "text-amber-600" : "text-emerald-600";
  return { active, daysLeft, pct, label, tone, style: usageBarStyle(pct) };
}
