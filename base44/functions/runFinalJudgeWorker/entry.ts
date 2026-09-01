import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { ANALYSIS_VERSION } from '../../shared/analysis.js';

function jstDateStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const nowMs = Date.now();
    const raceDate = jstDateStr();
    const races = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'deadline', 300
    );
    const finals = await base44.asServiceRole.entities.UichiAnalysis.filter(
      { race_date: raceDate, stage: 'final' }, '-captured_at', 500
    ).catch(() => []);

    const latestFinalByRace:any = {};
    for (const a of finals) if (!latestFinalByRace[a.race_id]) latestFinalByRace[a.race_id] = a;
    const doneFinal = new Set(
      finals.filter(a => a?.judgment && a.judgment !== 'PENDING').map(a => a.race_id)
    );

    // Base44の最短実行間隔は5分。2分ずらした安全ワーカーと合わせて実質2〜3分間隔で監視するため、
    // 判定窓は13分前から開け、展示が揃った最初の巡回で確定する。これにより遅くとも10分前付近までの確定を狙う。
    // 5分前以降は欠場などの安全確認だけ行う。
    const targets = races.filter(r => {
      if (!r?.deadline) return false;
      const deadlineMs = new Date(r.deadline).getTime();
      if (!Number.isFinite(deadlineMs)) return false;
      const finalAt = deadlineMs - 13 * 60 * 1000;
      return nowMs >= finalAt && nowMs < deadlineMs;
    });

    if (targets.length === 0) {
      return Response.json({ status: 'success', race_date: raceDate, targets: 0, judged: 0, errors: 0 });
    }

    const oddsReadyIds:string[] = [];
    const scratchDetectedIds:string[] = [];
    let fetchErrors = 0;
    // 公式サイトへの瞬間的な集中を避けるため2レースずつ処理する。
    // fetchRaceData側にも45秒キャッシュ＋短時間リトライがある。
    for (let i = 0; i < targets.length; i += 2) {
      const batch = targets.slice(i, i + 2);
      const result = await Promise.all(batch.map(async (r) => {
        try {
          const deadlineMs = new Date(r.deadline).getTime();
          const withinSafetyWindow = Number.isFinite(deadlineMs) && nowMs >= deadlineMs - 5 * 60 * 1000;
          const prevFinal = latestFinalByRace[r.id];
          const alreadyDone = doneFinal.has(r.id)
            && String(prevFinal?.analysis_version || '') === ANALYSIS_VERSION
            && prevFinal?.exhibition_gate_status
            && prevFinal.exhibition_gate_status !== 'MISSING';

          // 10分前で一度正式確定した後、5分前までは再取得しない。
          // 5分前以降だけ欠場等の安全確認を行う。
          if (alreadyDone && !withinSafetyWindow) {
            return { id: r.id, hasScratch: false, alreadyDone: true, skippedSafety: true };
          }

          try {
            await base44.asServiceRole.functions.invoke('fetchBeforeInfo', {
              race_date: raceDate,
              jcd: r.venue_code,
              race_number: r.race_number,
            });
          } catch {}

          const res = await base44.asServiceRole.functions.invoke('fetchRaceData', {
            race_date: raceDate,
            jcd: r.venue_code,
            race_number: r.race_number,
          });
          const data = res?.data || res;
          if (data?.status !== 'success') return null;
          const hasScratch = data?.has_scratch === true || (Array.isArray(data?.scratched_boats) && data.scratched_boats.length > 0);
          return { id: r.id, hasScratch, alreadyDone, skippedSafety: false };
        } catch {
          return null;
        }
      }));
      for (const item of result) {
        if (!item) { fetchErrors++; continue; }
        // 未判定レースは通常finalへ。確定済みは欠場時だけ再分析して強制SKIPへ更新する。
        if (!item.alreadyDone || item.hasScratch) oddsReadyIds.push(item.id);
        if (item.hasScratch) scratchDetectedIds.push(item.id);
      }
    }

    let analysisResult:any = null;
    if (oddsReadyIds.length > 0) {
      const res = await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
        race_date: raceDate,
        stage: 'final',
        race_ids: oddsReadyIds,
        force: true,
      });
      analysisResult = res?.data || res;
    }

    const latestFinals = oddsReadyIds.length > 0
      ? await base44.asServiceRole.entities.UichiAnalysis.filter(
          { race_date: raceDate, stage: 'final' }, '-captured_at', 500
        ).catch(() => [])
      : [];
    const latestByRace:any = {};
    for (const a of latestFinals) if (!latestByRace[a.race_id]) latestByRace[a.race_id] = a;

    let slackSent = 0;
    for (const raceId of oddsReadyIds) {
      const a = latestByRace[raceId];
      if (!a || !['BUY', 'WATCH'].includes(a.judgment)) continue;
      try {
        const res = await base44.asServiceRole.functions.invoke('notifySlackAlert', {
          race_id: raceId,
          stage: 'final',
        });
        const data = res?.data || res;
        if (data?.sent) slackSent++;
      } catch {}
    }

    return Response.json({
      status: 'success', race_date: raceDate,
      targets: targets.length,
      odds_ready: oddsReadyIds.length,
      judged: latestFinals.filter(a => oddsReadyIds.includes(a.race_id) && a.judgment && a.judgment !== 'PENDING').length,
      fetch_errors: fetchErrors,
      scratch_detected: scratchDetectedIds.length,
      scratch_race_ids: scratchDetectedIds,
      slack_sent: slackSent,
      analysis: analysisResult,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
