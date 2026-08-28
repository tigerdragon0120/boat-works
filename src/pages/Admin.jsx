import { useEffect, useState } from "react";
import { Settings as SettingsIcon, Loader2, Save, Check } from "lucide-react";
import { getSettings, updateSettings } from "@/lib/boatService";
import { VENUES } from "@/lib/boat";
import { cn } from "@/lib/utils";
import BackfillStatusBanner from "@/components/BackfillStatusBanner";

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    let m = true;
    (async () => {
      setLoading(true);
      const s = await getSettings();
      if (m) setSettings(s);
      setLoading(false);
    })();
    return () => { m = false; };
  }, []);

  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  const toggleVenue = (code) => {
    const cur = settings.venues_enabled || [];
    set("venues_enabled", cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateSettings(settings.id, {
        settings_version: (Number(settings.settings_version) || 1) + 1,
        buy_threshold: Number(settings.buy_threshold),
        watch_threshold: Number(settings.watch_threshold),
        pre_alert_rate: Number(settings.pre_alert_rate),
        min_similar_races: Number(settings.min_similar_races),
        min_buy_sample: Number(settings.min_buy_sample ?? 100),
        reliability_a_threshold: Number(settings.reliability_a_threshold ?? 500),
        reliability_b_threshold: Number(settings.reliability_b_threshold ?? 250),
        reliability_c_threshold: Number(settings.reliability_c_threshold ?? 100),
        analysis_period_months: Number(settings.analysis_period_months),
        odds_update_interval: Number(settings.odds_update_interval),
        notification_on: settings.notification_on,
        venues_enabled: settings.venues_enabled,
        trust_weight_basic: Number(settings.trust_weight_basic ?? 20),
        trust_weight_lane1: Number(settings.trust_weight_lane1 ?? 20),
        trust_weight_venue: Number(settings.trust_weight_venue ?? 15),
        trust_weight_st: Number(settings.trust_weight_st ?? 10),
        trust_weight_motor: Number(settings.trust_weight_motor ?? 10),
        trust_weight_weather: Number(settings.trust_weight_weather ?? 10),
        trust_strong_threshold: Number(settings.trust_strong_threshold ?? 85),
        trust_buy_threshold: Number(settings.trust_buy_threshold ?? 75),
        notify_min_ev: Number(settings.notify_min_ev ?? 110),
        notify_min_trust_score: Number(settings.notify_min_trust_score ?? 0),
        notify_only_strong: settings.notify_only_strong ?? false,
        notify_watch: settings.notify_watch ?? false,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" />読み込み中…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <SettingsIcon className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-bold">管理設定</h1>
      </div>

      <BackfillStatusBanner />

      <div className="rounded-2xl bg-card border border-border p-4">
        <div className="font-bold text-sm">データ更新は自動です</div>
        <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
          レース結果の保存、過去データの補完、1号艇詳細の補完、集計更新はバックグラウンドで自動実行します。通常は手動操作不要です。
        </div>
      </div>

      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider">最終判定の基準</h3>
        <div className="text-xs text-muted-foreground leading-relaxed">数字が高いほど判定は厳しくなります。通常は初期値のままでOKです。</div>
        <NumField label="BUYにする期待値" help="110なら、期待値指数110%以上をBUY判定の基準にします。" value={settings.buy_threshold} onChange={(v) => set("buy_threshold", v)} />
        <NumField label="WATCHにする期待値" help="100なら、100%以上110未満をWATCHの基準にします。100未満はSKIPです。" value={settings.watch_threshold} onChange={(v) => set("watch_threshold", v)} />
        <NumField label="前日にアラートへ出す最低出現率" help="現在は20%。これ未満は1号艇や5/6号艇が良くてもアラートにしません。" value={settings.pre_alert_rate} onChange={(v) => set("pre_alert_rate", v)} />
        <NumField label="アラートに必要な1号艇信頼" help="現在は75点。イン逃げを信頼できる1号艇だけを候補に残します。" value={settings.pre_min_boat1_trust ?? 75} onChange={(v) => set("pre_min_boat1_trust", v)} />
        <NumField label="5・6号艇の最低穴期待" help="現在は55点。5号艇か6号艇のどちらかに、3着へ食い込める材料が必要です。" value={settings.pre_min_outer_score ?? 55} onChange={(v) => set("pre_min_outer_score", v)} />
        <NumField label="S評価に必要な5・6号艇穴期待" help="現在は65点。S評価は1号艇だけでなく、5/6号艇にも強い買い材料が必要です。" value={settings.pre_strong_outer_score ?? 65} onChange={(v) => set("pre_strong_outer_score", v)} />
        <NumField label="分析に必要な類似レース数" help="似た条件の過去レースがこの件数未満なら『データ不足』として扱います。" value={settings.min_similar_races} onChange={(v) => set("min_similar_races", v)} />
        <NumField label="BUYを出すための最低データ数" help="分析サンプルがこの件数に届かない場合、期待値が高くてもBUYを抑制します。" value={settings.min_buy_sample ?? 100} onChange={(v) => set("min_buy_sample", v)} />
      </div>

      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider">データ量による信頼度</h3>
        <div className="text-xs text-muted-foreground leading-relaxed">過去データが何件あれば分析をA・B・C評価にするかの基準です。Aが最も信頼できる表示です。</div>
        <NumField label="A評価に必要なデータ数" help="500件以上なら信頼度Aとして表示します。" value={settings.reliability_a_threshold ?? 500} onChange={(v) => set("reliability_a_threshold", v)} />
        <NumField label="B評価に必要なデータ数" help="250件以上500件未満なら信頼度Bの目安です。" value={settings.reliability_b_threshold ?? 250} onChange={(v) => set("reliability_b_threshold", v)} />
        <NumField label="C評価に必要なデータ数" help="100件以上250件未満なら信頼度Cの目安です。これ未満はデータ不足です。" value={settings.reliability_c_threshold ?? 100} onChange={(v) => set("reliability_c_threshold", v)} />
      </div>

      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider">1号艇の強さを何で評価するか</h3>
        <div className="text-xs text-muted-foreground leading-relaxed">1号艇が逃げ切れそうかを採点する配点です。数字が大きい項目ほど重視します。通常は変更不要です。</div>
        <NumField label="選手基本力（最大点）" value={settings.trust_weight_basic ?? 20} onChange={(v) => set("trust_weight_basic", v)} />
        <NumField label="1コース信頼性（最大点）" value={settings.trust_weight_lane1 ?? 20} onChange={(v) => set("trust_weight_lane1", v)} />
        <NumField label="当地相性（最大点）" value={settings.trust_weight_venue ?? 15} onChange={(v) => set("trust_weight_venue", v)} />
        <NumField label="ST評価（最大点）" value={settings.trust_weight_st ?? 10} onChange={(v) => set("trust_weight_st", v)} />
        <NumField label="モーター評価（最大点）" value={settings.trust_weight_motor ?? 10} onChange={(v) => set("trust_weight_motor", v)} />
        <NumField label="天候適性（最大点・データ不足時は対象外）" value={settings.trust_weight_weather ?? 10} onChange={(v) => set("trust_weight_weather", v)} />
        <NumField label="STRONG BUYしきい値（信頼スコア）" value={settings.trust_strong_threshold ?? 85} onChange={(v) => set("trust_strong_threshold", v)} />
        <NumField label="BUY候補しきい値（信頼スコア）" value={settings.trust_buy_threshold ?? 75} onChange={(v) => set("trust_buy_threshold", v)} />
      </div>

      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider">データ・更新</h3>
        <NumField label="過去何か月を分析するか" help="6なら直近6か月の過去データを分析に使います。" value={settings.analysis_period_months} onChange={(v) => set("analysis_period_months", v)} />
        <NumField label="オッズを何秒ごとに更新するか" help="60なら対象時間帯のオッズを約60秒間隔で更新します。" value={settings.odds_update_interval} onChange={(v) => set("odds_update_interval", v)} />
      </div>

      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider">プッシュ通知条件</h3>
        <ToggleField label="通知ON/OFF" value={settings.notification_on} onChange={(v) => set("notification_on", v)} />
        <div className="border-t border-border pt-3 space-y-4">
          <NumField label="通知する最低期待値指数（%）" value={settings.notify_min_ev ?? 110} onChange={(v) => set("notify_min_ev", v)} />
          <NumField label="通知する最低信頼スコア（0=无条件）" value={settings.notify_min_trust_score ?? 0} onChange={(v) => set("notify_min_trust_score", v)} />
          <ToggleField label="STRONG BUYのみ通知" value={settings.notify_only_strong ?? false} onChange={(v) => set("notify_only_strong", v)} />
          <ToggleField label="WATCH判定も通知" value={settings.notify_watch ?? false} onChange={(v) => set("notify_watch", v)} />
        </div>
      </div>

      <div className="rounded-2xl bg-card border border-border p-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider mb-3">競艇場ON/OFF</h3>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {VENUES.map((v) => {
            const on = (settings.venues_enabled || []).includes(v.code);
            return (
              <button
                key={v.code}
                onClick={() => toggleVenue(v.code)}
                className={cn(
                  "px-2 py-2 rounded-lg text-sm border transition-colors",
                  on ? "bg-primary/15 border-primary/40 text-primary font-semibold" : "bg-background/50 border-border text-muted-foreground"
                )}
              >
                {v.name}
              </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="w-full py-3 rounded-2xl bg-primary text-primary-foreground font-bold flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
        {saving ? "保存中…" : saved ? "保存しました" : "設定を保存"}
      </button>
    </div>
  );
}

function NumField({ label, help, value, onChange }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="min-w-0">
        <label className="text-sm font-medium">{label}</label>
        {help && <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{help}</div>}
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 shrink-0 px-3 py-2 rounded-lg bg-background border border-border text-right tabular-nums text-sm focus:outline-none focus:border-primary"
      />
    </div>
  );
}

function ToggleField({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-sm">{label}</label>
      <button
        onClick={() => onChange(!value)}
        className={cn("w-12 h-7 rounded-full transition-colors relative", value ? "bg-primary" : "bg-muted")}
      >
        <span className={cn("absolute top-1 w-5 h-5 rounded-full bg-white transition-all", value ? "left-6" : "left-1")} />
      </button>
    </div>
  );
}