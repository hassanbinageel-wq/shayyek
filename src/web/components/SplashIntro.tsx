import { useEffect, useRef, useState } from "react";
import { APP_TARGET } from "../platform";

/**
 * The opening animation: the mark flies in from off the left edge like a paper plane — an arc before the words,
 * then along their line, bigger than them so it covers them — and the words appear right behind it (a sharp edge
 * just left of the mark's inner cut, so no letter ever shows inside the plane). It lands with a soft settle and
 * the screen fades away. On the web once per visit (tab), in the app on every cold start; a tap skips it, and
 * with "reduce motion" the logo just shows briefly.
 */

const base = import.meta.env.BASE_URL;
// The logo files' coordinates (source units): the whole logo, the mark's box, the mark file's box.
const VB = { x: 178, y: 212, w: 1712, h: 583 };
const M = { x0: 1320, x1: 1878, y0: 225, y1: 783, cx: 1599, cy: 504, w: 558 };
const MARK_FILE = { x: 1316, y: 221, w: 566, h: 566 };
const CUT = 1392; // the words' edge: just left of the mark's inner cut

const FLY = 2.3; // flight
const HOLD = 2.75; // start fading out
const END = 3.05;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x: number) => x * x * (3 - 2 * x);
type Pt = [number, number];
const bez = (P: Pt[], k: number): Pt => {
  const m = 1 - k;
  return [0, 1].map((i) => m * m * m * P[0][i] + 3 * m * m * k * P[1][i] + 3 * m * k * k * P[2][i] + k * k * k * P[3][i]) as Pt;
};

/** The flight path, built for the box's on-screen position so it always starts fully off the left edge. */
function buildPath(boxLeftPx: number, k: number) {
  const x0 = (-M.w * k * 0.75 - 40 - boxLeftPx) / k + VB.x;
  const A: Pt[] = [[x0, M.cy + 300], [x0 + 290, M.cy - 330], [200, M.cy + 30], [700, M.cy + 10]];
  const B: Pt[] = [A[3], [2 * A[3][0] - A[2][0], 2 * A[3][1] - A[2][1]], [M.cx - 260, M.cy - 70], [M.cx, M.cy]];
  const at = (q: number) => (q < 0.5 ? bez(A, q * 2) : bez(B, q * 2 - 1));
  // arc-length table: equal time steps give an even, continuous speed along the curve
  const N = 600;
  const pts: Pt[] = [];
  const len = [0];
  for (let i = 0; i <= N; i++) pts.push(at(i / N));
  for (let i = 1; i <= N; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = len[N];
  const pointAt = (sv: number): Pt => {
    const d = clamp(sv) * total;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (len[mid] < d) lo = mid;
      else hi = mid;
    }
    const f = (d - len[lo]) / Math.max(1e-6, len[hi] - len[lo]);
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
  };
  return { pointAt, total };
}

function shouldShow(): boolean {
  if (APP_TARGET === "app") return true; // every cold start of the app
  if (/^#\/(plans|reset)/.test(location.hash)) return false; // links people open for the content itself
  try {
    if (sessionStorage.getItem("shayyek.splash")) return false;
    sessionStorage.setItem("shayyek.splash", "1");
  } catch {
    /* storage blocked: show it */
  }
  return true;
}

// Decided once when the app loads (not per render).
const SHOW_ON_LOAD = shouldShow();

/** Light only (no dark mode). */
function isDark(): boolean {
  return false;
}

export function SplashIntro() {
  const [show, setShow] = useState(SHOW_ON_LOAD);
  const [fade, setFade] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLImageElement>(null);
  const words = useRef<HTMLImageElement>(null);
  const trail = useRef<SVGPathElement>(null);
  const skip = useRef<() => void>(() => undefined);
  const [dark] = useState(isDark);

  useEffect(() => {
    if (!show) return;
    let raf = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      setFade(true);
      setTimeout(() => setShow(false), 320);
    };
    skip.current = finish;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const imgs = [words.current, plane.current?.querySelector("img")].filter(Boolean) as HTMLImageElement[];
    const ready = Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : i.decode().catch(() => undefined))));
    const safety = setTimeout(finish, 6000); // never stuck on the intro
    ready.then(() => {
      const el = box.current;
      if (!el || done) return;
      if (reduce) {
        if (words.current) words.current.style.clipPath = "none";
        setTimeout(finish, 700);
        return;
      }
      const rect = el.getBoundingClientRect();
      const k = rect.width / VB.w; // px per source unit
      const { pointAt, total } = buildPath(rect.left, k);
      const progress = (t: number) => 1 - Math.pow(1 - clamp(t / FLY), 3);
      const start = performance.now();
      const frame = (now: number) => {
        const t = (now - start) / 1000;
        const sv = progress(t);
        const [px, py] = pointAt(sv);
        const [ax, ay] = pointAt(Math.max(0, sv - 0.004));
        const [bx, by] = pointAt(Math.min(1, sv + 0.004));
        const ang = (Math.atan2(by - ay, Math.max(1e-3, bx - ax)) * 180) / Math.PI;
        const tilt = clamp(ang * 0.9, -30, 30) * (1 - smooth(clamp((t - FLY + 0.5) / 0.5)));
        const land = clamp((t - FLY + 0.05) / 0.5);
        const grow = smooth(clamp(sv / 0.12)) * (1 - smooth(clamp((sv - 0.74) / 0.26)));
        const sc = (1 + 0.32 * grow) * (1 + (0.04 * (1 - Math.cos(2 * Math.PI * land))) / 2);
        if (plane.current) plane.current.style.transform = `translate(${(px - M.cx) * k}px, ${(py - M.cy) * k}px) rotate(${tilt}deg) scale(${sc})`;
        // the words: everything left of the edge, which sits under the plane
        const edge = t >= FLY ? VB.x + VB.w : px + (CUT - M.cx) * sc;
        if (words.current) words.current.style.clipPath = `inset(0 ${clamp(1 - (edge - VB.x) / VB.w) * 100}% 0 0)`;
        // a short trail along the curve, ending at the plane's tail and fading as it lands
        if (trail.current) {
          const behind = (M.w * 0.5 * sc) / total;
          const tail: string[] = [];
          for (let i = 40; i >= 0; i--) {
            const q = sv - behind - 0.16 * (i / 40);
            if (q >= 0) tail.push(pointAt(q).join(","));
          }
          trail.current.setAttribute("d", tail.length > 1 ? `M${tail.join(" L")}` : "");
          trail.current.style.opacity = String(0.5 * (1 - smooth(clamp((t - FLY + 0.6) / 0.6))));
        }
        if (glow.current) glow.current.style.opacity = String(0.45 * Math.max(0, Math.sin(Math.PI * clamp((t - FLY + 0.1) / 0.8))));
        if (t >= HOLD) return finish();
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });
    return () => {
      done = true;
      clearTimeout(safety);
      cancelAnimationFrame(raf);
    };
  }, [show]);

  if (!show) return null;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div
      onClick={() => skip.current()}
      aria-hidden="true"
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      style={{ background: dark ? "#0d0b16" : "#ffffff", opacity: fade ? 0 : 1, transition: `opacity ${END - HOLD}s ease` }}
    >
      <div ref={box} className="relative" style={{ width: "min(57vw, 380px)", aspectRatio: `${VB.w} / ${VB.h}` }}>
        <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`}>
          <defs>
            <linearGradient id="splash-trail" x1="0" x2="1">
              <stop offset="0" stopColor="#7c3aed" stopOpacity="0" />
              <stop offset=".6" stopColor="#db2777" stopOpacity=".55" />
              <stop offset="1" stopColor="#f97316" stopOpacity=".9" />
            </linearGradient>
          </defs>
          <path ref={trail} fill="none" stroke="url(#splash-trail)" strokeWidth="8" strokeLinecap="round" />
        </svg>
        <img ref={words} src={`${base}brand/words-${dark ? "dark" : "light"}.svg`} alt="" className="absolute inset-0 h-full w-full" style={{ clipPath: "inset(0 100% 0 0)" }} />
        <div
          ref={plane}
          className="absolute"
          style={{
            left: pct(MARK_FILE.x - VB.x, VB.w),
            top: pct(MARK_FILE.y - VB.y, VB.h),
            width: pct(MARK_FILE.w, VB.w),
            height: pct(MARK_FILE.h, VB.h),
            transformOrigin: `${pct(M.cx - MARK_FILE.x, MARK_FILE.w)} ${pct(M.cy - MARK_FILE.y, MARK_FILE.h)}`,
            willChange: "transform",
            transform: `translate(-200vw, 0)`,
          }}
        >
          <img ref={glow} src={`${base}brand/mark.svg`} alt="" className="absolute inset-0 h-full w-full" style={{ filter: "blur(10px)", opacity: 0 }} />
          <img src={`${base}brand/mark.svg`} alt="" className="absolute inset-0 h-full w-full" />
        </div>
      </div>
    </div>
  );
}
