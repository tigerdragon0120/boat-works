import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';
import {
  VENUE_NAMES, fetchBoatcastText, parseStr3, parseTkz, parseOdds, parseRs1, parseRs2,
  discoverVenues, defaultDeadline
} from '../../shared/boatcastSync.js';

// BOAT WORKS: BOATCASTから1日分のレースデータを自動取得・同期
// 開催場検出 → Race/RaceEntry生成 → 展示/オッズ/結果同期
// エンティティ操作を最小化してレートリミットを回避

function jstDate(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const TIME_BUDGET_MS = 100000;

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ ok: false, error: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const targetOffset = Number(body.target_offset ?? 0);
    const raceDate = body.race_date || jstDate(targetOffset);
    const syncDetails = body.sync_details !== false && targetOffset === 0;
    const t0 = Date.now();

    // 1. 開催場検出
    const venues = await discoverVenues(raceDate);

    // 2. 既存Race/RaceEntryを一括取得(エンティティ操作削減)
    const existingRaces = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate }, 'race_number', 500
    ).catch(() => []);
    const raceByKey = new Map();
    for (const r of existingRaces) {
      raceByKey.set(`${String(r.venue_code).padStart(2,'0')}_${Number(r.race_number)}`, r);
    }

    const existingEntries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_date: raceDate }, 'boat_number', 5000
    ).catch(() => []);
    const entriesByRaceId = new Map();
    for (const e of existingEntries) {
      if (!entriesByRaceId.has(e.race_id)) entriesByRaceId.set(e.race_id, []);
      entriesByRaceId.get(e.race_id).push(e);
    }

    // 3. 各開催場のSTR3を取得してRace/RaceEntry生成
    let racesCreated = 0, racesUpdated = 0, entriesCreated = 0, entriesUpdated = 0;
    const venueResults = [];
    const newEntriesToCreate = [];
    const racesToUpdate = [];
    const entriesToUpdate = [];

    for (const vc of venues) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;

      const venueName = VENUE_NAMES[vc] || vc;
      let venueRaces = 0, venueEntries = 0;

      // STR3を1R〜12Rまで並列取得
      const str3Results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          fetchBoatcastText({ type: 'STR3', venueCode: vc, raceDate, raceNumber: i + 1 })
            .then(r => ({ raceNumber: i + 1, result: r }))
            .catch(() => ({ raceNumber: i + 1, result: { ok: false } }))
        )
      );

      for (const { raceNumber, result } of str3Results) {
        if (!result.ok) continue;
        const entries = parseStr3(result.text);
        if (entries.length === 0) continue;

        const key = `${vc}_${raceNumber}`;
        const existing = raceByKey.get(key);
        const scratchedBoats = entries.filter(e => e.is_scratched).map(e => e.boat_number);
        const now = new Date().toISOString();

        const raceFields = {
          race_date: raceDate,
          venue_code: vc,
          venue_name: venueName,
          race_number: raceNumber,
          race_name: `${raceNumber}R`,
          grade: 'GENERAL',
          series_key: `${vc}_${raceDate}`,
          series_start_date: raceDate,
          series_end_date: raceDate,
          series_total_days: 1,
          series_day: 1,
          deadline: defaultDeadline(raceDate, raceNumber),
          status: 'scheduled',
          data_source: 'official',
          scratched_boats: scratchedBoats,
          entries_fetched_at: now,
          last_updated: now,
        };

        let raceId;
        if (existing) {
          const updateFields = { ...raceFields };
          if (existing.status === 'finished') delete updateFields.status;
          if (existing.result_trifecta) delete updateFields.result_trifecta;
          if (existing.payout_trifecta != null) delete updateFields.payout_trifecta;
          racesToUpdate.push({ id: existing.id, fields: updateFields });
          raceId = existing.id;
          racesUpdated++;
        } else {
          // 個別create(後で実行)
          const created = await base44.asServiceRole.entities.Race.create(raceFields);
          raceId = created.id;
          raceByKey.set(key, created);
          racesCreated++;
        }

        // RaceEntry処理
        const existingRaceEntries = entriesByRaceId.get(raceId) || [];
        const entryMap = new Map(existingRaceEntries.map(e => [Number(e.boat_number), e]));

        for (const entry of entries) {
          const old = entryMap.get(entry.boat_number);
          const entryFields = {
            race_id: raceId,
            race_date: raceDate,
            venue_code: vc,
            race_number: raceNumber,
            boat_number: entry.boat_number,
            registration_number: entry.registration_number,
            racer_name: entry.racer_name,
            grade_class: entry.grade_class,
            branch: entry.branch,
            age: entry.age,
            avg_st: entry.avg_st,
            national_win_rate: entry.national_win_rate,
            national_2rate: entry.national_2rate,
            national_3rate: entry.national_3rate,
            local_win_rate: entry.local_win_rate,
            local_2rate: entry.local_2rate,
            local_3rate: entry.local_3rate,
            f_count: entry.f_count,
            motor_number: entry.motor_number,
            motor_2rate: entry.motor_2rate,
            motor_3rate: entry.motor_3rate,
            boat_number_id: entry.boat_number_id,
            boat_2rate: entry.boat_2rate,
            boat_3rate: entry.boat_3rate,
            season_record: entry.season_record,
            is_scratched: entry.is_scratched,
          };

          if (old) {
            const update = {};
            for (const [k, v] of Object.entries(entryFields)) {
              if (['exhibition_time', 'exhibition_st', 'exhibition_rank', 'tilt', 'weight', 'entry_course'].includes(k)) continue;
              update[k] = v;
            }
            entriesToUpdate.push({ id: old.id, fields: update });
            entriesUpdated++;
          } else {
            newEntriesToCreate.push(entryFields);
            entriesCreated++;
          }
          venueEntries++;
        }

        venueRaces++;
      }

      venueResults.push({ venue: vc, venue_name: venueName, races: venueRaces, entries: venueEntries });
    }

    // 4. バッチ更新実行(bulkUpdateでAPI呼び出しを削減)
    if (racesToUpdate.length > 0) {
      for (let i = 0; i < racesToUpdate.length; i += 100) {
        const batch = racesToUpdate.slice(i, i + 100).map(({ id, fields }) => ({ id, ...fields }));
        await base44.asServiceRole.entities.Race.bulkUpdate(batch).catch(() => {});
      }
    }
    if (entriesToUpdate.length > 0) {
      for (let i = 0; i < entriesToUpdate.length; i += 100) {
        const batch = entriesToUpdate.slice(i, i + 100).map(({ id, fields }) => ({ id, ...fields }));
        await base44.asServiceRole.entities.RaceEntry.bulkUpdate(batch).catch(() => {});
      }
    }
    // 新規RaceEntryはbulkCreate
    if (newEntriesToCreate.length > 0) {
      for (let i = 0; i < newEntriesToCreate.length; i += 100) {
        await base44.asServiceRole.entities.RaceEntry.bulkCreate(newEntriesToCreate.slice(i, i + 100)).catch(() => {});
      }
    }

    // 5. 当日分の展示・オッズ・結果を同期
    let oddsCount = 0, resultsCount = 0, exhibitionCount = 0;
    if (syncDetails) {
      const races = await base44.asServiceRole.entities.Race.filter(
        { race_date: raceDate }, 'race_number', 500
      ).catch(() => []);

      for (const race of races) {
        if (Date.now() - t0 > TIME_BUDGET_MS) break;

        const vc = String(race.venue_code).padStart(2, '0');
        const rn = Number(race.race_number);

        try {
          // 展示タイム(TKZ)
          const tkz = await fetchBoatcastText({ type: 'TKZ', venueCode: vc, raceDate, raceNumber: rn });
          if (tkz.ok) {
            const exhibition = parseTkz(tkz.text);
            const entries = entriesByRaceId.get(race.id) || await base44.asServiceRole.entities.RaceEntry.filter({ race_id: race.id }, 'boat_number', 20).catch(() => []);
            const entryMap = new Map(entries.map(e => [Number(e.boat_number), e]));

            let hasExhibition = false;
            const exUpdates = [];
            for (const ex of exhibition) {
              const old = entryMap.get(ex.boat_number);
              if (old) {
                const update = {};
                if (ex.exhibition_time != null && ex.exhibition_time > 0) { update.exhibition_time = ex.exhibition_time; hasExhibition = true; }
                if (ex.weight != null) update.weight = ex.weight;
                if (ex.tilt != null) update.tilt = ex.tilt;
                if (ex.exhibition_st != null) { update.exhibition_st = ex.exhibition_st; hasExhibition = true; }
                if (Object.keys(update).length > 0) exUpdates.push({ id: old.id, fields: update });
              }
            }
            for (const { id, fields } of exUpdates) await base44.asServiceRole.entities.RaceEntry.update(id, fields).catch(() => {});
            if (hasExhibition) {
              exhibitionCount++;
              await base44.asServiceRole.entities.Race.update(race.id, {
                exhibition_ready: true,
                beforeinfo_fetched_at: new Date().toISOString(),
              }).catch(() => {});
            }
          }

          // オッズ(ODDS)
          const odds = await fetchBoatcastText({ type: 'ODDS', venueCode: vc, raceDate, raceNumber: rn, force: true });
          if (odds.ok) {
            const oddsMap = parseOdds(odds.text);
            if (Object.keys(oddsMap).length > 0) {
              await base44.asServiceRole.entities.OddsSnapshot.create({
                race_id: race.id,
                race_date: raceDate,
                captured_at: new Date().toISOString(),
                stage: '5min',
                all_trifecta_odds: oddsMap,
                odds_1_2_5: oddsMap['1-2-5'] || null,
                odds_1_2_6: oddsMap['1-2-6'] || null,
                odds_1_3_5: oddsMap['1-3-5'] || null,
                odds_1_3_6: oddsMap['1-3-6'] || null,
                odds_1_4_5: oddsMap['1-4-5'] || null,
                odds_1_4_6: oddsMap['1-4-6'] || null,
                scratched_boats: race.scratched_boats || [],
                has_scratch: (race.scratched_boats || []).length > 0,
              }).catch(() => {});
              await base44.asServiceRole.entities.Race.update(race.id, {
                odds_fetched_at: new Date().toISOString(),
              }).catch(() => {});
              oddsCount++;
            }
          }

          // レース結果(RS1/RS2) - 確定済みでない場合のみ
          if (race.status !== 'finished') {
            const rs1 = await fetchBoatcastText({ type: 'RS1', venueCode: vc, raceDate, raceNumber: rn });
            if (rs1.ok) {
              const result = parseRs1(rs1.text);
              if (result.trifecta) {
                const rs2 = await fetchBoatcastText({ type: 'RS2', venueCode: vc, raceDate, raceNumber: rn });
                let payoutTrifecta = null;
                if (rs2.ok) {
                  const payouts = parseRs2(rs2.text);
                  payoutTrifecta = payouts.trifectaPayout;
                }

                await base44.asServiceRole.entities.Race.update(race.id, {
                  status: 'finished',
                  result_trifecta: result.trifecta,
                  payout_trifecta: payoutTrifecta,
                  weather: result.weather,
                  wind_dir: result.windDir,
                  wind_speed: result.windSpeed,
                  wave_height: result.waveHeight,
                  last_updated: new Date().toISOString(),
                }).catch(() => {});

                // RaceEntryに進入コースを反映
                const entries = entriesByRaceId.get(race.id) || await base44.asServiceRole.entities.RaceEntry.filter({ race_id: race.id }, 'boat_number', 20).catch(() => []);
                const entryMap = new Map(entries.map(e => [Number(e.boat_number), e]));
                for (const [bn, course] of Object.entries(result.startCourses)) {
                  const old = entryMap.get(Number(bn));
                  if (old && course != null) {
                    await base44.asServiceRole.entities.RaceEntry.update(old.id, { entry_course: course }).catch(() => {});
                  }
                }
                resultsCount++;
              }
            }
          }
        } catch (e) {
          // 個別レースエラーは続行
        }
      }
    }

    return Response.json({
      ok: true,
      date: raceDate,
      target_offset: targetOffset,
      venues: venues.length,
      venue_details: venueResults,
      races_created: racesCreated,
      races_updated: racesUpdated,
      entries_created: entriesCreated,
      entries_updated: entriesUpdated,
      exhibition_synced: exhibitionCount,
      odds_synced: oddsCount,
      results_synced: resultsCount,
      elapsed_ms: Date.now() - t0,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}