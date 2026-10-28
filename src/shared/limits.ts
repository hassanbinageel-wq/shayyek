/** Repetition limits of a campaign, shared by the API, the engine and the campaign editor. */

/** Deliveries of a campaign's content to the same person: 1 or 2. Older data: 0 (= no limit) and larger values → 2. */
export const MAX_DELIVERIES_CAP = 2;
export const clampDeliveries = (v: number) => (!(v >= 1) ? MAX_DELIVERIES_CAP : Math.min(MAX_DELIVERIES_CAP, Math.trunc(v)));
/** Wait before the same campaign answers the same person again: 24 or 72 hours (older values → the nearest). */
export const COOLDOWN_CHOICES = [24, 72] as const;
export const clampCooldown = (h: number) => (h > 24 ? 72 : 24);
