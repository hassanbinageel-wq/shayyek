import { useEffect, useState } from "react";
import { enablePush, markAsked, shouldOfferWeb } from "../lib/push";
import { Icon } from "./Icon";
import { toast } from "./ui";

/** One-time banner on the home page (website): turn on notifications for this device, or "later" (not asked again). */
export function PushPrompt() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void shouldOfferWeb().then(setShow).catch(() => undefined);
  }, []);
  if (!show) return null;
  const close = () => {
    markAsked();
    setShow(false);
  };
  const enable = async () => {
    setBusy(true);
    try {
      if (await enablePush()) toast("تم تفعيل الإشعارات على هذا الجهاز ✓");
      else toast("ما انعطى الإذن — تقدر تفعّلها لاحقًا من الإعدادات", "info");
    } catch (e: any) {
      toast(e?.message || "ما قدرنا نفعّل الإشعارات", "bad");
    } finally {
      setBusy(false);
      close();
    }
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-violet-500/25 bg-violet-500/[0.06] p-3.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-700"><Icon name="bell" size={20} /></span>
      <span className="min-w-0 flex-1 leading-tight">
        <b className="block text-sm">خلّ الإشعارات توصلك حتى لو الموقع مسكّر</b>
        <span className="muted text-xs">رسائل الإدارة، انفصال الحساب، قرب انتهاء الاشتراك، ونفاد المخزون — تقدر تطفّيها من الإعدادات.</span>
      </span>
      <span className="flex gap-2">
        <button className="btn btn-ghost min-h-10 text-xs" disabled={busy} onClick={close}>لاحقًا</button>
        <button className="btn btn-primary min-h-10 text-xs" disabled={busy} onClick={enable}>فعّل</button>
      </span>
    </div>
  );
}
