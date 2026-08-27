import { useEffect, useState } from "react";
import { Settings as SettingsIcon, Loader2, Save, Check } from "lucide-react";
import { getSettings, updateSettings } from "@/lib/boatService";
import { VENUES } from "@/lib/boat";
import { cn } from "@/lib/utils";
import HistoricalFetchPanel from "@/components/HistoricalFetchPanel";
import ErrorRetryPanel from "@/components/ErrorRetryPanel";
import BackfillStatusBanner from "@/components/BackfillStatusBanner";
import BatchAnalysisPanel from "@/components/BatchAnalysisPanel";
import AggregationPanel from "@/components/AggregationPanel";

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

      <AggregationPanel />

      <BatchAnalysisPanel />

      <HistoricalFetchPanel />

      <ErrorRetryPanel />

      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider">判定しきい値</h3>
        <NumField label="BUY判定期待値（%）" value={settings.buy_threshold} onChange={(v) => set("buy_threshold", v)} />
        <NumField label="WATCH判定期待値（%）" value={settings.watch_threshold} onChange={(v) => set("watch_threshold", v)} />
        <NumField label="前日アラート出現率（%）" value={settings.pre_alert_rate} onChange={(v) => set("pre_alert_rate", v)} />
        <NumField label="類似レース最低件数" value={settings.min_similar_races} onChange={(v) => set("min_similar_races", v)} />
        <NumField label="BUY判定最低サンプル数" value={settings.min_buy_sample ?? 100} onChange={(v) => set("min_buy_sample", v)} />
      </div>

      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider">分析信頼度しきい値</h3>
        <NumField label="信頼度A（n ≥ ）" value={settings.reliability_a_threshold ?? 500} onChange={(v) => set("reliability_a_threshold", v)} />
        <NumField label="信頼度B（n ≥ ）" value={settings.reliability_b_threshold ?? 250} onChange={(v) => set("reliability_b_threshold", v)} />
        <NumField label="信頼度C（n ≥ ）" value={settings.reliability_c_threshold ?? 100} onChange={(v) => set("reliability_c_threshold", v)} />
      </div>

      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <h3 className="text-sm font-bold text-muted-foreground tracking-wider">1号艇信頼スコア重み</h3>
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
        <NumField label="データ分析期間（月）" value={settings.analysis_period_months} onChange={(v) => set("analysis_period_months", v)} />
        <NumField label="オッズ更新間隔（秒）" value={settings.odds_update_interval} onChange={(v) => set("odds_update_interval", v)} />
        <ToggleField label="通知ON/OFF" value={settings.notification_on} onChange={(v) => set("notification_on", v)} />
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

function NumField({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-sm">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 px-3 py-2 rounded-lg bg-background border border-border text-right tabular-nums text-sm focus:outline-none focus:border-primary"
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