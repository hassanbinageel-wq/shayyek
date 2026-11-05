import { describe, expect, it } from "vitest";
import { subscriptionLeft } from "../src/web/lib/messagesBar";

const DAY = 86_400_000;
const now = 1_800_000_000_000;

describe("subscriptionLeft (days-left bar)", () => {
  it("fills with the time used of a month and counts days left", () => {
    const half = subscriptionLeft(now + 15 * DAY, now);
    expect(half).toMatchObject({ active: true, daysLeft: 15, pct: 50, label: "باقي 15 يوم", tone: "text-emerald-600" });
    expect(subscriptionLeft(now + 391 * DAY, now)).toMatchObject({ daysLeft: 391, pct: 0 });
    expect(subscriptionLeft(now + 5 * DAY, now)).toMatchObject({ label: "باقي 5 أيام", tone: "text-amber-600" });
    expect(subscriptionLeft(now + DAY / 2, now)).toMatchObject({ daysLeft: 1, label: "باقي 1 يوم", tone: "text-red-600" });
  });
  it("ended or missing subscriptions show full and red", () => {
    expect(subscriptionLeft(now - DAY, now)).toMatchObject({ active: false, pct: 100, label: "منتهي", tone: "text-red-600" });
    expect(subscriptionLeft(null, now)).toMatchObject({ active: false, label: "لا يوجد اشتراك" });
  });
});
