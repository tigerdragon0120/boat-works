import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function jstDateStr(offsetDays = 0) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offsetDays);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

const resultKey = (x) => `${x.race_date}_${String(x.venue_code || '').padStart(2, '0')}_${Number(x.race_number || 0)}`;

async function processDate(base44, raceDate, nowMs) {
  const [races, alerts, results, learningRows] = await Promise.all([
    base44.asServiceRole.entities.Race.filter({ race_date: raceDate, data_source: 'official' }, 'deadline', 300).catch(() => []),
    base44.asServiceRole.entities.Alert.filter({ race_date: raceDate }, 'race_number', 500).catch(() => []),
    base44.asServiceRole.entities.RaceResult.filter({ race_date: raceDate, data_source: 'official' }, 'race_number', 500).catch(() => []),
    base44.asServiceRole.entities.UichiLearningSample.filter({ race_date: raceDate }, 'race_number', 500).catch(() => []),
  ]);

  const resultKeys = new Set(results.map(resultKey));
  const venueTargets = new Set<string>();

  // Raceがある日は、締切25分後を過ぎた未結果レースの開催場を回収対象にする。
  for (const r of races) {
    if (!r?.deadline || resultKeys.has(resultKey(r))) continue;
    const deadlineMs = new Date(r.deadline).getTime();
    if (!Number.isFinite(deadlineMs)) continue;
    if (nowMs >= deadlineMs + 25 * 60 * 1000) venueTargets.add(String(r.venue_code).padStart(2, '0'));
  }

  // 前日などRaceが欠けていても、終了済みAlertが結果待ちならその開催場を回収する。
  for (const a of alerts) {
    if (resultKeys.has(resultKey(a))) continue;
    const deadlineMs = a.deadline ? new Date(a.deadline).getTime() : 0;
    if (!deadlineMs || nowMs >= deadlineMs + 25 * 60 * 1000) {
      venueTargets.add(String(a.venue_code).padStart(2, '0'));
    }
  }

  let venuesDone = 0, errors = 0, saved = 0;
  const venues = [...venueTargets];
  for (let i = 0; i < venues.length; i += 3) {
    const batch = venues.slice(i, i + 3);
    const out = await Promise.all(batch.map(async (jcd) => {
      try {
        const res = await base44.asServiceRole.functions.invoke('fetchHistoricalResults', { race_date: raceDate, jcd });
        const data = res?.data || res;
        try {
          const detailRes = await base44.asServiceRole.functions.invoke('enrichRaceResultDetails', { race_date: raceDate, jcd });
          data.detail_enrichment = detailRes?.data || detailRes;
        } catch (e) {
          data.detail_enrichment = { status: 'error', message: e?.message || String(e) };
        }
        return data;
      } catch (e) {
        return { status: 'error', message: e.message };
      }
    }));
    for (const r of out) {
      if (r?.status === 'success' || r?.status === 'no_races') {
        venuesDone++;
        saved += r?.races || 0;
      } else errors++;
    }
  }

  const refreshed = await base44.asServiceRole.entities.RaceResult.filter(
    { race_date: raceDate, data_source: 'official' }, 'race_number', 500
  ).catch(() => []);
  const refreshedKeys = new Set(refreshed.map(resultKey));
  // 公式結果が揃ったAlertは、resolved化の前にBUY的中Slack通知を試す。
  // notifySlackAlert側でBUYかつ推奨パターン的中のみ送信し、重複も防止する。
  let slackResultSent = 0;
  for (const a of alerts.filter(a => refreshedKeys.has(resultKey(a)))) {
    try {
      const res = await base44.asServiceRole.functions.invoke('notifySlackAlert', {
        race_id: a.race_id,
        stage: 'result',
      });
      const data = res?.data || res;
      if (data?.sent) slackResultSent++;
    } catch {}
  }

  const updates = alerts
    .filter(a => refreshedKeys.has(resultKey(a)) && a.status !== 'resolved')
    .map(a => ({ id: a.id, status: 'resolved' }));
  if (updates.length > 0) await base44.asServiceRole.entities.Alert.bulkUpdate(updates);

  // 学習サンプルへ公式結果を結合。予想時点の特徴量は上書きしない。
  const learningByKey = new Map(learningRows.map(x => [resultKey(x), x]));
  const learningUpdates = [];
  for (const result of refreshed) {
    const sample = learningByKey.get(resultKey(result));
    if (!sample || sample.result_attached_at) continue;
    const r1 = Number(result.result_1 || 0), r2 = Number(result.result_2 || 0), r3 = Number(result.result_3 || 0);
    const mainHit = r1 === 1 && [2,3,4].includes(r2) && [5,6].includes(r3);
    const uraHit = r1 === 1 && [5,6].includes(r2) && [2,3,4].includes(r3);
    const recommendedHit = sample.recommended_pattern === 'MAIN' ? mainHit : sample.recommended_pattern === 'URA' ? uraHit : false;
    learningUpdates.push({
      id: sample.id,
      result_1: r1, result_2: r2, result_3: r3,
      trifecta: result.trifecta,
      payout_trifecta: result.payout_trifecta,
      boat1_win: r1 === 1,
      main_hit: mainHit,
      ura_hit: uraHit,
      recommended_hit: recommendedHit,
      outcome_pattern: mainHit ? 'MAIN' : uraHit ? 'URA' : 'OTHER',
      result_attached_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  if (learningUpdates.length > 0) await base44.asServiceRole.entities.UichiLearningSample.bulkUpdate(learningUpdates);

  return {
    race_date: raceDate,
    target_venues: venues.length,
    venues_done: venuesDone,
    fetch_errors: errors,
    fetched_races: saved,
    resolved_alerts: updates.length,
    slack_result_sent: slackResultSent,
    learning_samples_updated: learningUpdates.length,
    total_results: refreshed.length,
  };
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const nowMs = Date.now();
    const requested = body.race_date ? [body.race_date] : [jstDateStr(0), jstDateStr(-1)];
    const dates = [...new Set(requested)];
    const processed = [];
    for (const raceDate of dates) processed.push(await processDate(base44, raceDate, nowMs));

    return Response.json({ status: 'success', processed });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
