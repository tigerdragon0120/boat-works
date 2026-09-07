import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { upsertRace } from '../../shared/raceUpsert.js';
import { recalcAllVenuesForDate } from '../../shared/venueReadiness.js';

// V2公式データ（OfficialRaceCoreV2/OfficialRaceEntryV2）からV1データ（Race/RaceEntry）へ同期する。
// V2取込済みだがV1が未作成の日付に対して、スクレイピングなしでV1を構築する。
// 既存V1データがある場合は上書きせず、不足分のみ補完する。

function deriveTimeSlot(deadline) {
  if (!deadline) return 'day';
  const h = new Date(deadline).getHours();
  if (h < 10) return 'morning';
  if (h >= 14) return 'night';
  return 'day';
}

function deriveGrade(raceName, seriesTitle) {
  const text = `${raceName || ''} ${seriesTitle || ''}`;
  if (text.includes('グランプリ') || text.includes('SG')) return 'SG';
  if (text.includes('プレミア') || text.includes('G1') || text.includes('GI')) return 'G1';
  if (text.includes('G2') || text.includes('GII')) return 'G2';
  if (text.includes('G3') || text.includes('GIII')) return 'G3';
  return 'GENERAL';
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    if (!raceDate) {
      return Response.json({ status: 'error', message: 'race_dateが必要です' }, { status: 400 });
    }

    // recalc_onlyモード: V2→V1同期をスキップし、VenueDayReadiness再計算のみ実行
    if (body.recalc_only === true) {
      let readinessResult = null;
      try {
        readinessResult = await recalcAllVenuesForDate(base44, raceDate);
      } catch (e) {
        return Response.json({ status: 'error', message: e?.message || String(e) }, { status: 500 });
      }
      return Response.json({ status: 'success', race_date: raceDate, readiness_recalc: readinessResult });
    }

    const now = new Date().toISOString();

    // 1. V2公式データを取得
    const coreV2 = await base44.asServiceRole.entities.OfficialRaceCoreV2.filter(
      { race_date: raceDate, record_status: 'VALID' }, 'race_number', 500
    ).catch(() => []);

    if (!coreV2 || coreV2.length === 0) {
      return Response.json({
        status: 'error',
        message: `OfficialRaceCoreV2に${raceDate}のデータがありません`,
        race_date: raceDate,
      });
    }

    // 2. 既存V1 Raceを取得（重複作成防止）
    const existingRaces = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'race_number', 500
    ).catch(() => []);
    const existingRaceMap = new Map();
    for (const r of existingRaces) {
      const key = `${String(r.venue_code).padStart(2, '0')}_${Number(r.race_number)}`;
      existingRaceMap.set(key, r);
    }

    // 3. V2 Race → V1 Race upsert
    let raceCreated = 0;
    let raceUpdated = 0;
    let raceSkipped = 0;
    const v1RaceIds = new Map(); // key → V1 Race id

    for (const v2 of coreV2) {
      const jcd = String(v2.venue_code).padStart(2, '0');
      const raceNumber = Number(v2.race_number);
      const logicalKey = `${jcd}_${raceNumber}`;

      const seriesDay = v2.series_day_number || 1;
      const seriesStartDate = new Date(raceDate);
      seriesStartDate.setDate(seriesStartDate.getDate() - (seriesDay - 1));
      const seriesStartDateStr = seriesStartDate.toISOString().slice(0, 10);

      const raceData = {
        race_date: raceDate,
        venue_code: jcd,
        venue_name: v2.venue_name || jcd,
        race_number: raceNumber,
        race_name: v2.race_name || null,
        deadline: v2.deadline_time || null,
        event_name: v2.series_title || null,
        grade: deriveGrade(v2.race_name, v2.series_title),
        series_key: v2.series_title ? `${jcd}_${seriesStartDateStr}` : null,
        series_start_date: seriesStartDateStr,
        series_end_date: seriesStartDateStr,
        series_total_days: 1,
        series_day: seriesDay,
        is_final_day: false,
        time_slot: deriveTimeSlot(v2.deadline_time),
        status: 'scheduled',
        data_source: 'official',
        last_updated: now,
        entries_fetched_at: now,
      };

      const existing = existingRaceMap.get(logicalKey);
      try {
        const saved = await upsertRace(base44, raceData);
        v1RaceIds.set(logicalKey, saved.id);
        if (existing) {
          raceUpdated++;
        } else {
          raceCreated++;
        }
      } catch (e) {
        raceSkipped++;
      }
    }

    // 4. V2 Entry → V1 Entry作成
    const entryV2 = await base44.asServiceRole.entities.OfficialRaceEntryV2.filter(
      { race_date: raceDate, record_status: 'VALID' }, 'boat_number', 5000
    ).catch(() => []);

    // V1 RaceEntryを一括取得（重複作成防止）
    const allV1RaceIds = [...v1RaceIds.values()];
    const existingEntries = [];
    for (let i = 0; i < allV1RaceIds.length; i += 200) {
      const chunk = allV1RaceIds.slice(i, i + 200);
      const ents = await base44.asServiceRole.entities.RaceEntry.filter(
        { race_id: { $in: chunk } }, 'boat_number', 1000
      ).catch(() => []);
      existingEntries.push(...ents);
    }
    const existingEntryMap = new Map(); // race_id_boat_number → exists
    for (const e of existingEntries) {
      existingEntryMap.set(`${e.race_id}_${Number(e.boat_number)}`, e);
    }

    let entryCreated = 0;
    let entryUpdated = 0;
    let entrySkipped = 0;
    const entriesToCreate = [];

    for (const v2e of entryV2) {
      const jcd = String(v2e.venue_code).padStart(2, '0');
      const raceNumber = Number(v2e.race_number);
      const logicalKey = `${jcd}_${raceNumber}`;
      const v1RaceId = v1RaceIds.get(logicalKey);
      if (!v1RaceId) { entrySkipped++; continue; }

      const boatNumber = Number(v2e.boat_number);
      const entryData = {
        race_id: v1RaceId,
        race_date: raceDate,
        venue_code: jcd,
        race_number: raceNumber,
        boat_number: boatNumber,
        registration_number: v2e.registration_number || null,
        racer_name: v2e.racer_name || null,
        age: v2e.age || null,
        branch: v2e.branch || null,
        weight: v2e.weight || null,
        grade_class: v2e.class || null,
        national_win_rate: v2e.national_win_rate || null,
        national_2rate: v2e.national_top2_rate || null,
        local_win_rate: v2e.local_win_rate || null,
        local_2rate: v2e.local_top2_rate || null,
        motor_number: v2e.motor_number || null,
        motor_2rate: v2e.motor_top2_rate || null,
        boat_number_id: v2e.boat_number_official || null,
        boat_2rate: v2e.boat_top2_rate || null,
        season_record: v2e.series_results_raw || null,
      };

      const existingKey = `${v1RaceId}_${boatNumber}`;
      const existing = existingEntryMap.get(existingKey);
      if (existing) {
        // 既存エントリがある場合は更新（nullで上書きしない）
        const updateData = {};
        for (const [k, v] of Object.entries(entryData)) {
          if (v != null && existing[k] == null) updateData[k] = v;
        }
        if (Object.keys(updateData).length > 0) {
          try {
            await base44.asServiceRole.entities.RaceEntry.update(existing.id, updateData);
            entryUpdated++;
          } catch { entrySkipped++; }
        } else {
          entrySkipped++;
        }
      } else {
        entriesToCreate.push(entryData);
      }
    }

    // バルク作成
    if (entriesToCreate.length > 0) {
      for (let i = 0; i < entriesToCreate.length; i += 200) {
        await base44.asServiceRole.entities.RaceEntry.bulkCreate(entriesToCreate.slice(i, i + 200));
      }
      entryCreated = entriesToCreate.length;
    }

    // 5. VenueDayReadinessを再計算
    let readinessResult = null;
    try {
      readinessResult = await recalcAllVenuesForDate(base44, raceDate);
    } catch (e) {
      readinessResult = { status: 'error', message: e?.message || String(e) };
    }

    // 6. 最終件数確認
    const finalRaces = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'race_number', 500
    ).catch(() => []);
    const finalEntries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_date: raceDate }, 'boat_number', 5000
    ).catch(() => []);
    const finalReadiness = await base44.asServiceRole.entities.VenueDayReadiness.filter(
      { race_date: raceDate }, 'venue_code', 100
    ).catch(() => []);

    const venueSet = new Set(finalRaces.map(r => String(r.venue_code).padStart(2, '0')));

    // 7. Bファイル同期が完了し、全レース6艇が揃ったら事前予想を即時開始する。
    // Webサイトへの出走表取得は行わず、Bファイル由来のRace/RaceEntry + RacerTermStatV2だけで分析する。
    let preAnalysis = null;
    const expectedEntries = finalRaces.length * 6;
    const programComplete = finalRaces.length > 0 && finalEntries.length >= expectedEntries;
    if (programComplete && body.skip_pre_analysis !== true) {
      try {
        const res = await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
          race_date: raceDate,
          stage: 'pre',
          force: true,
        });
        preAnalysis = res?.data || res || { status: 'started' };
      } catch (e) {
        preAnalysis = { status: 'error', message: e?.message || String(e) };
      }
    } else if (!programComplete) {
      preAnalysis = {
        status: 'waiting',
        message: `Bファイル未完成: Race ${finalRaces.length} / Entry ${finalEntries.length} (必要 ${expectedEntries})`,
      };
    }

    return Response.json({
      status: 'success',
      race_date: raceDate,
      v2_core_count: coreV2.length,
      v2_entry_count: entryV2.length,
      race_created: raceCreated,
      race_updated: raceUpdated,
      race_skipped: raceSkipped,
      entry_created: entryCreated,
      entry_updated: entryUpdated,
      entry_skipped: entrySkipped,
      readiness_recalc: readinessResult,
      final_counts: {
        race_count: finalRaces.length,
        entry_count: finalEntries.length,
        readiness_count: finalReadiness.length,
        venue_count: venueSet.size,
      },
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}