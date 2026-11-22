import { useEffect, useState } from "react";
import { api } from "../api";
import { isNative } from "../platform";
import { disablePush, enablePush, needsHomeScreen, pushAvailable, pushBlocked, pushEnabled } from "../lib/push";
import { Alert, Card, Spinner, Toggle, toast } from "./ui";

/** Turns phone/desktop notifications on or off for this device only. */
export function PushCard() {
  const [state, setState] = useState<{ available: boolean; on: boolean; blocked: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => setState({ available: await pushAvailable(), on: await pushEnabled(), blocked: pushBlocked() });
  useEffect(() => {
    void load();
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        if (!(await enablePush())) toast("ما انعطى إذن الإشعارات — فعّله من إعدادات الجهاز", "bad");
        else toast("تم تفعيل الإشعارات على هذا الجهاز ✓");
      } else {
        await disablePush();
        toast("انطفت الإشعارات على هذا الجهاز");
      }
    } catch (e: any) {
      toast(e?.message || "ما قدرنا نفعّل الإشعارات", "bad");
    } finally {
      setBusy(false);
      void load();
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await api<{ sent: number }>("/api/push/test", { method: "POST", body: {} });
      toast(r.sent ? "أرسلنا إشعار تجربة — شيّك على جهازك" : "ما فيه جهاز مفعّل يستقبل الحين", r.sent ? "good" : "bad");
    } catch (e: any) {
      toast(e?.message || "ما قدرنا نرسل التجربة", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={isNative ? "إشعارات الجوال" : "إشعارات الجهاز"}>
      {!state ? (
        <Spinner />
      ) : needsHomeScreen() ? (
        <Alert tone="info">في الآيفون: افتح شيّك من Safari، اضغط «مشاركة» ← «إضافة إلى الشاشة الرئيسية»، وافتحه من الأيقونة الجديدة، وبعدها فعّل الإشعارات من هنا.</Alert>
      ) : !state.available ? (
        <Alert tone="info">هذا الجهاز أو المتصفح ما يدعم الإشعارات.</Alert>
      ) : (
        <div className="space-y-3">
          <Toggle
            checked={state.on}
            disabled={busy}
            onChange={toggle}
            label="وصّل لي الإشعارات المهمة على هذا الجهاز"
            description="حتى لو التطبيق مسكّر: رسائل الإدارة، انفصال الحساب، فشل الإرسال، قرب انتهاء الاشتراك، نفاد المخزون، وردود الدعم."
          />
          {state.blocked && <Alert tone="warn">الإشعارات محظورة لهذا الموقع في المتصفح — اسمح بها من إعدادات الموقع (رمز القفل جنب الرابط) وارجع فعّلها.</Alert>}
          {state.on && (
            <button className="btn btn-ghost" disabled={busy} onClick={test}>
              إرسال إشعار تجربة
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
