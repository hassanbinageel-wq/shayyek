import { useState } from "react";
import { askConfirm } from "../components/Confirm";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Alert, Card, Empty, PageHeader, Spinner, fmtTime, toast, useAsync } from "../components/ui";

export const REASONS: Record<string, string> = {
  campaign_matched: "طابق حملة",
  no_keyword_match: "لا توجد كلمة مطابقة",
  excluded_keyword: "كلمة استثناء",
  threaded_reply_excluded: "رد متفرع غير مشمول",
  own_account: "من حسابك نفسه",
  message_echo: "صدى رسالة مرسلة (echo)",
  event_before_activation: "أقدم من وقت التفعيل",
  media_not_in_scope: "المنشور خارج نطاق الحملة",
  no_active_campaign: "لا توجد حملة نشطة لهذا النوع",
  no_matching_campaign: "لم تطابق أي حملة",
  max_deliveries_reached: "بلغ حد التسليم للمستخدم",
  user_cooldown: "ضمن فترة الانتظار للمستخدم",
  user_hourly_limit: "تجاوز حد الساعة للمستخدم",
  flow_already_open: "يوجد مسار مفتوح لنفس المستخدم",
  plain_message_no_trigger: "رسالة عادية بدون مسار",
  verify_cooldown: "طلب تحقق خلال فترة الانتظار",
  verify_attempts_exceeded: "تجاوز حد محاولات التحقق",
  invalid_button_token: "زر غير صالح لهذا المستخدم",
  automation_paused: "الأتمتة متوقفة",
  unsupported_event: "حدث غير مدعوم",
  reaction_not_a_trigger: "تفاعل إيموجي — ليس مشغلًا",
  flow_start: "بدأ التحقق بعد تفاعل المستخدم",
  verify_requested: "طلب تحقق جديد",
  verify_deferred: "طلب تحقق مجدول لنهاية الفاصل",
  story_not_identifiable: "لا يمكن تحديد الستوري",
  unknown_account: "حساب غير معروف",
  account_not_active: "الحساب غير متصل",
  customer_suspended: "حساب العميل موقوف",
};

/** The log section: only the undo of recent changes (events, flows and actions were removed at the owner's request). */
export function LogsPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="السجل" />
      <UndoPanel />
    </div>
  );
}

const UNDO_ICON: Record<string, string> = { campaign: "target", template: "puzzle", design: "palette", draw: "gift", settings: "settings" };

function UndoPanel() {
  const { data, loading, error, reload } = useAsync(() => api<any[]>("/api/undo"), []);
  const [busy, setBusy] = useState<number | null>(null);
  const undo = async (o: any) => {
    if (!(await askConfirm({ title: `استرجاع: ${o.label}؟`, confirmLabel: "استرجاع" }))) return;
    setBusy(o.id);
    try {
      await api(`/api/undo/${o.id}`, { body: {} });
      toast(`تم الاسترجاع: ${o.label}`);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="آخر 10 عمليات" action={<span className="chip surface-2 muted">إضافة · تعديل · حذف</span>}>
      <p className="muted mb-3 text-sm">
        تقدر ترجع أي عملية من آخر 10 عمليات على الحملات والقوالب وتصاميم التهنئة والسحوبات والإعدادات. إذا كان على نفس العنصر عملية أحدث، استرجع الأحدث أولًا.
        الرسائل المرسلة لإنستقرام لا يمكن سحبها، والحملة المسترجَعة النشطة تبدأ من الآن ولا تعيد معالجة التعليقات القديمة.
      </p>
      {loading && !data ? <Spinner /> : error ? <Alert tone="bad">{error}</Alert> : !data!.length ? <Empty title="لا توجد عمليات بعد" /> : (
        <ul className="divide-y divide-[var(--border)]">
          {data!.map((o) => (
            <li key={o.id} className={`flex items-center gap-3 py-3 ${o.undone_at ? "opacity-60" : ""}`}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300">
                <Icon name={(UNDO_ICON[o.target.split(":")[0]] ?? "list") as any} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className={`truncate font-semibold ${o.undone_at ? "line-through" : ""}`}>{o.label}</div>
                <div className="muted text-xs">
                  {fmtTime(o.at)} · {o.actor}
                  {o.undone_at ? ` · استُرجعت ${fmtTime(o.undone_at)}` : o.blocked_by ? " · استرجع العملية الأحدث على نفس العنصر أولًا" : !o.revertible ? " · كبيرة الحجم ولم تُحفظ نسختها" : ""}
                </div>
              </div>
              {o.undone_at ? <span className="chip surface-2 muted">مسترجعة</span> : (
                <button className="btn btn-ghost min-h-10 shrink-0 gap-1.5 px-3 text-sm" disabled={!o.revertible || busy !== null} onClick={() => undo(o)}>
                  <Icon name="refresh" size={16} /> {busy === o.id ? "…" : "استرجاع"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
