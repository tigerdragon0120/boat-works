import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// Alert → UichiAnalysis(final) → RaceResult を結合し、アラート候補の履歴を返す。
// Alert/UichiAnalysis の race_id はBase44 Race.id、RaceResult.race_id は日付_場コード_R番号形式なので、
// RaceResult は race_date + venue_code + race_number で照合する。
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: 'error', message: '認証が必要です' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Number(body.limit || 500), 1000);

    const rawAlerts = await base44.asServiceRole.entities.Alert.filter({}, '-updated_date', limit).catch(() => []);
    // 過去に重複作成されたAlertがあっても、race_idごとに1件だけ採用する。
    // final確定済みAlertを優先し、同条件ならupdated_dateが新しいものを使う。
    const alertMap = new Map();
    for (const a of rawAlerts) {
      if (a.status === 'filtered_out' || !a.race_id) continue;
      const cur = alertMap.get(a.race_id);
      if (!cur) {
        alertMap.set(a.race_id, a);
        continue;
      }
      const curFinal = cur.final_judgment && cur.final_judgment !== 'PENDING';
      const aFinal = a.final_judgment && a.final_judgment !== 'PENDING';
      if (aFinal && !curFinal) alertMap.set(a.race_id, a);
    }
    const alerts = [...alertMap.values()];
    if (!alerts.length) {
      return Response.json({ status: 'success', summary: emptySummary(), rows: [] });
    }

    const ids = [...new Set(alerts.map(a => a.race_id).filter(Boolean))];
    const alertDates = [...new Set(alerts.map(a => a.race_date).filter(Boolean))];
    const resultRows = await base44.asServiceRole.entities.RaceResult.filter(
      { data_source: 'official', race_date: { $in: alertDates } }, '-race_date', Math.min(limit * 12, 5000)
    ).catch(() => []);
    const analyses = await base44.asServiceRole.entities.UichiAnalysis.filter(
      { race_id: { $in: ids } }, '-captured_at', Math.min(limit * 3, 2000)
    ).catch(() => []);

    const resultMap = new Map();
    const resultKey = (x) => `${x.race_date}_${String(x.venue_code || '').padStart(2, '0')}_${Number(x.race_number || 0)}`;
    for (const r of resultRows) {
      const k = resultKey(r);
      if (!resultMap.has(k)) resultMap.set(k, r);
    }

    const finalMap = new Map();
    const preMap = new Map();
    for (const a of analyses) {
      if (a.stage === 'final' && !finalMap.has(a.race_id)) finalMap.set(a.race_id, a);
      if (a.stage === 'pre' && !preMap.has(a.race_id)) preMap.set(a.race_id, a);
    }

    const rows = alerts.map(al => {
      const result = resultMap.get(resultKey(al)) || null;
      const final = finalMap.get(al.race_id) || null;
      const pre = preMap.get(al.race_id) || null;
      const judgment = final?.judgment || al.final_judgment || null;
      const completed = !!result;
      const hit = completed ? !!result.is_uichi : null;
      return {
        race_id: al.race_id,
        race_date: al.race_date,
        venue_code: al.venue_code,
        venue_name: al.venue_name,
        race_number: al.race_number,
        deadline: al.deadline,
        pre_grade: al.pre_grade || pre?.pre_grade || null,
        pre_appearance_rate: al.pre_appearance_rate ?? pre?.appearance_rate ?? null,
        boat1_trust_score: final?.boat1_trust_score ?? pre?.boat1_trust_score ?? null,
        condition_match_score: final?.condition_match_score ?? pre?.condition_match_score ?? null,
        final_judgment: judgment,
        final_expected_value: final?.expected_value ?? al.final_expected_value ?? null,
        synthetic_odds: final?.synthetic_odds ?? al.synthetic_odds ?? null,
        completed,
        result_trifecta: result?.trifecta || null,
        payout_trifecta: result?.payout_trifecta ?? null,
        is_uichi: hit,
      };
    }).filter(r => r.pre_grade || r.pre_appearance_rate != null);

    const completed = rows.filter(r => r.completed);
    const hits = completed.filter(r => r.is_uichi);
    const buy = completed.filter(r => r.final_judgment === 'BUY');
    const watch = completed.filter(r => r.final_judgment === 'WATCH');
    const noFinal = completed.filter(r => !r.final_judgment || r.final_judgment === 'PENDING');

    const summary = {
      alert_count: rows.length,
      completed_count: completed.length,
      hit_count: hits.length,
      hit_rate: completed.length ? hits.length / completed.length : 0,
      buy_count: buy.length,
      buy_hit_count: buy.filter(r => r.is_uichi).length,
      buy_hit_rate: buy.length ? buy.filter(r => r.is_uichi).length / buy.length : 0,
      watch_count: watch.length,
      watch_hit_count: watch.filter(r => r.is_uichi).length,
      watch_hit_rate: watch.length ? watch.filter(r => r.is_uichi).length / watch.length : 0,
      no_final_count: noFinal.length,
      pending_result_count: rows.length - completed.length,
    };

    return Response.json({ status: 'success', summary, rows });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

function emptySummary() {
  return {
    alert_count: 0, completed_count: 0, hit_count: 0, hit_rate: 0,
    buy_count: 0, buy_hit_count: 0, buy_hit_rate: 0,
    watch_count: 0, watch_hit_count: 0, watch_hit_rate: 0,
    no_final_count: 0, pending_result_count: 0,
  };
}
