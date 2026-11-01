import { webhookLabel } from "../../shared/states";
import { askConfirm, askChoice } from "../components/Confirm";
import { useState } from "react";
import { api } from "../api";
import { isNative, openOAuth } from "../platform";
import { StoreConnect } from "../components/StoreConnect";
import { AccountAvatar } from "../components/UserAvatar";
import { Toggle, Alert, Badge, Card, PageHeader, Spinner, fmtTime, toast, useAsync } from "../components/ui";

export function ConnectionPage() {
  const { data, loading, error, reload } = useAsync(() => api("/api/account"), []);
  const { data: me } = useAsync(() => api<{ is_owner?: boolean }>("/api/auth/me"), []);
  const [diagData, setDiagData] = useState<{ checks: Array<{ name: string; ok: boolean | null; detail?: string }> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const status = new URLSearchParams(location.hash.split("?")[1] ?? "").get("status");

  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="bad">{error}</Alert>;
  const a = data.account;
  const connected = a && a.status !== "disconnected";

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    run("connect", async () => {
      const r = await api<{ url: string }>("/api/account/connect", { body: { client: isNative ? "app" : "web" } });
      await openOAuth(r.url);
    });

  const missing = connected ? (data.required_scopes as string[]).filter((s) => !a.scopes.includes(s)) : [];

  return (
    <div className="space-y-4">
      <PageHeader title="الربط" subtitle={`١) حساب إنستقرام — أساسي لتشغيل الحملات · ٢) متجرك في سلة — اختياري لتحليل المبيعات والربح · Instagram API ${data.api_version}`} />
      {status === "ok" && <Alert tone="good">عاد المتصفح من Meta. الحالة أدناه مقروءة من الخادم مباشرة.</Alert>}
      {status === "error" && <Alert tone="bad">لم يكتمل الربط. أكثر سبب شائع: حساب إنستقرام <b>شخصي</b> — حوّله إلى «احترافي» (الإعدادات ← نوع الحساب والأدوات ← التبديل إلى حساب احترافي) ثم أعد المحاولة.</Alert>}
      {!data.configured && <Alert tone="warn">لم تُضبط بيانات تطبيق Meta على الخادم (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET).</Alert>}

      <Card title={<span className="flex items-center gap-2"><StepNo n={1} />حساب إنستقرام</span>}>
        {connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <AccountAvatar url={a.profile_picture_url} name={a.username} size={64} />
              <div>
                <div className="text-lg font-bold">@{a.username ?? "—"}</div>
                <div className="muted text-sm">{a.name ?? ""} {a.account_type ? `· ${a.account_type}` : ""}</div>
                <div className="muted text-xs" dir="ltr">IG ID: {a.ig_user_id}</div>
              </div>
            </div>
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div><dt className="muted">حالة التفويض</dt><dd><Badge value={a.status} label={a.status === "active" ? "فعّال" : a.status === "needs_reauth" ? "يحتاج إعادة ربط" : a.status} /></dd></div>
              <div><dt className="muted">انتهاء التفويض</dt><dd>{a.token_expires_at ? fmtTime(a.token_expires_at) : "غير متاح"}</dd></div>
              <div><dt className="muted">استقبال التعليقات والرسائل</dt><dd><Badge value={a.webhook_status} label={webhookLabel(a.webhook_status)} /> <span className="muted">({a.webhook_fields.join(", ") || "—"})</span></dd></div>
              <div><dt className="muted">آخر حدث وصل</dt><dd>{fmtTime(a.last_webhook_at)}</dd></div>
              <div><dt className="muted">التحقق من المتابعة</dt><dd><Badge value={a.follow_check_support} label={{ supported: "مدعوم (تم رصد الحقل)", unsupported: "غير متاح", unknown: "لم يُختبر بعد" }[a.follow_check_support as string]} /></dd></div>
              <div><dt className="muted">آخر تجديد للتوكن</dt><dd>{fmtTime(a.token_refreshed_at)}</dd></div>
            </dl>
            {a.follow_check_note && <Alert tone="warn">سبب تعذر التحقق من المتابعة: {a.follow_check_note}</Alert>}
            {me?.is_owner && <div className="rounded-2xl border border-amber-300/60 px-4 py-1 dark:border-amber-800/60">
              <Toggle
                checked={!!a.follow_gate_allowed}
                disabled={!!busy}
                onChange={(v) =>
                  run("gate", async () => {
                    if (v && !(await askConfirm({ title: "تفعيل شرط المتابعة الإلزامي؟", message: "معيار Meta للسبام يمنع ربط المحتوى بالمتابعة، والمخاطرة على هذا الحساب تتحملها أنت. لا تعرضه في مراجعة Meta ولا تفعّله لحسابات العملاء.", confirmLabel: "أفهم المخاطرة — فعّل", danger: true }))) return;
                    await api("/api/account/follow-gate", { body: { allowed: v } });
                    toast(v ? "تم السماح بشرط المتابعة لهذا الحساب" : "أُوقف شرط المتابعة — الحملات تُرسل المحتوى للجميع");
                    reload();
                  })
                }
                label="السماح بشرط المتابعة الإلزامي (لحساباتك فقط)"
                description="عند الإيقاف: أي حملة عليها الشرط ترسل المحتوى للجميع مباشرة. باقي الحملات تستخدم الدعوة الاختيارية."
              />
            </div>}
            {a.last_error && <Alert tone="warn">آخر خطأ: {a.last_error}</Alert>}
          </div>
        ) : (
          <div className="space-y-2">
          <Alert tone="warn">
            <b>حسابك في إنستقرام لازم يكون «احترافي»</b> (أعمال أو صانع محتوى) — الحساب الشخصي ما يقدر يرتبط.
            <span className="mt-1 block text-xs leading-relaxed">من تطبيق إنستقرام: الإعدادات ← نوع الحساب والأدوات ← «التبديل إلى حساب احترافي» ← اختر «أعمال». مجاني، وتقدر ترجع عنه وقت ما تبغى.</span>
          </Alert>
          <Alert tone="info">لا يوجد حساب متصل. سيُفتح تسجيل الدخول الرسمي من Meta في متصفح النظام — لا نطلب كلمة المرور داخل التطبيق.</Alert>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={connect} disabled={!!busy || !data.configured}>
            {connected ? "إعادة الاتصال" : "ربط عبر Instagram"}
          </button>
          {connected && (
            <>
              <button className="btn btn-ghost" disabled={!!busy} onClick={() => run("sub", async () => { await api("/api/account/resubscribe", { body: {} }); toast("تم تفعيل استقبال التعليقات والرسائل"); reload(); })}>إعادة تفعيل الاستقبال</button>
              <button className="btn btn-ghost" disabled={!!busy} onClick={() => run("ref", async () => { await api("/api/account/refresh-token", { body: {} }); toast("تم تجديد التفويض"); reload(); })}>تجديد التفويض</button>
              <button className="btn btn-ghost" disabled={!!busy} onClick={() => run("diag", async () => setDiagData(await api("/api/account/diagnostics")))}>تشخيص الربط</button>
              <button
                className="btn btn-danger"
                disabled={!!busy}
                onClick={() =>
                  run("disc", async () => {
                    const choice = await askChoice({
                      title: "فصل حساب إنستقرام؟",
                      message: "تتوقف الأتمتة وتُلغى المهام المعلّقة ويُحذف التفويض. تقدر تربط الحساب من جديد في أي وقت.",
                      choices: [
                        { label: "فصل الحساب فقط (نحتفظ بالسجل)", value: "keep" },
                        { label: "فصل وحذف بيانات المتفاعلين والمسارات", value: "purge", danger: true },
                      ],
                    });
                    if (!choice) return;
                    const purge = choice === "purge";
                    await api("/api/account/disconnect", { body: { purge } });
                    toast("تم فصل الحساب");
                    reload();
                  })
                }
              >
                فصل الحساب وإيقاف الأتمتة
              </button>
            </>
          )}
        </div>
      </Card>

      {diagData && (
        <Card title="نتيجة التشخيص">
          <ul className="space-y-2">
            {diagData.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2">
                <span>{c.ok === true ? "✅" : c.ok === false ? "❌" : "⚪"}</span>
                <span><b>{c.name}</b>{c.detail && <span className="muted"> — {c.detail}</span>}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <StoreConnect />

      {/* Missing permissions: the only thing left of the permissions box (the list and the Meta settings are not shown). */}
      {missing.length > 0 && <Alert tone="warn">صلاحيات ناقصة: {missing.join(", ")} — أعد الربط ووافق عليها.</Alert>}
    </div>
  );
}

function StepNo({ n }: { n: number }) {
  return <span className="grad grid size-6 shrink-0 place-items-center rounded-full text-xs font-extrabold text-white" aria-hidden>{n}</span>;
}
