import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS, syntheticOdds } from "../../shared/uichi.js";
import { VENUE_NAMES, toNum, toFloat, parseRacelist } from "../../shared/scraper.js";
import { upsertRace } from "../../shared/raceUpsert.js";
import { fetchTextWithRetry, inferScratchedBoats, parseOdds3t, ODDS_CACHE_MS } from "../../shared/oddsParser.js";

// BOAT WORKS 公式サイト実データ取得関数
// BOAT RACE公式サイト(boatrace.jp)から出走表・3連単オッズを取得しDBへ保存する。
// 公式サイトへのアクセスはここに集約。フロントエンドはDBを見るだけ。
// 取得失敗時は架空データを作らずエラーを返す。
// 注意: この関数は「出走表＋オッズ」を同時取得する。当日のFinal Judge通常処理からは
// fetchRaceOddsOnlyを使用し、Race/RaceEntryを再取得しない設計に変更済み。

const BASE = "https://boatrace.jp/owpc/pc/race";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date; // YYYY-MM-DD
    const jcd = String(body.jcd || body.venue_code || "").padStart(2, "0");
    const raceNumber = Number(body.race_number);

    if (!raceDate || !jcd || !raceNumber) {
      return Response.json({ status: "error", message: "race_date, jcd, race_number が必要です" }, { status: 400 });
    }

    const hd = raceDate.replace(/-/g, "");
    const racelistUrl = `${BASE}/racelist?rno=${raceNumber}&jcd=${jcd}&hd=${hd}`;
    const oddsUrl = `${BASE}/odds3t?rno=${raceNumber}&jcd=${jcd}&hd=${hd}`;

    // 同一レースへの重複アクセス抑止。45秒以内の完全な公式オッズがあれば再利用する。
    const existingRace = await base44.asServiceRole.entities.Race.filter({
      race_date: raceDate, venue_code: jcd, race_number: raceNumber
    });
    const currentRace = existingRace[0] || null;
    if (!body.force && currentRace?.odds_fetched_at) {
      const ageMs = Date.now() - new Date(currentRace.odds_fetched_at).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ODDS_CACHE_MS) {
        const snapshots = await base44.asServiceRole.entities.OddsSnapshot.filter(
          { race_id: currentRace.id }, "-captured_at", 1
        ).catch(() => []);
        const cached = snapshots[0];
        const cachedOdds = cached?.all_trifecta_odds || {};
        const cachedScratch = inferScratchedBoats(cachedOdds);
        const cachedValidCount = cachedScratch.count;
        if (cachedValidCount >= 120 || cachedScratch.isConsistent) {
          const cachedScratched = cachedScratch.isConsistent ? cachedScratch.scratched : (cached.scratched_boats || []);
          return Response.json({
            status: "success", race: currentRace, entries: 6, odds_count: cachedValidCount,
            synthetic_odds: cached.synthetic_odds ?? null,
            captured_at: cached.captured_at,
            scratched_boats: cachedScratched,
            has_scratch: cachedScratched.length > 0 || cached.has_scratch === true,
            exhibition_ready: currentRace?.exhibition_ready === true,
            beforeinfo_fetched_at: currentRace?.beforeinfo_fetched_at ?? null,
            cached: true,
          });
        }
      }
    }

    // 出走表取得。一時的な不完全レスポンスは短い間隔で再試行する。
    const rlFetched = await fetchTextWithRetry(racelistUrl, (html) => {
      const value = parseRacelist(html, raceNumber, raceDate);
      return value.entries?.length >= 6
        ? { ok: true, value }
        : { ok: false, message: `出走表取得失敗：${value.entries?.length || 0}件（6艇未満）` };
    }, "出走表");
    const parsed = rlFetched.value;

    // オッズ取得。120通り揃わない途中レスポンスは即エラーにせず最大2回再試行する。
    const odFetched = await fetchTextWithRetry(oddsUrl, (html) => {
      const value = parseOdds3t(html);
      const scratch = inferScratchedBoats(value);
      const count = scratch.count;
      if (count >= 120) return { ok: true, value };
      if (scratch.isConsistent) return { ok: true, value };
      return { ok: false, message: `オッズ取得失敗：${count}件（120通り未満）` };
    }, "オッズ");
    const allOdds = odFetched.value;
    const scratchInfo = inferScratchedBoats(allOdds);
    const oddsCount = scratchInfo.count;
    const scratchedBoats = oddsCount < 120 && scratchInfo.isConsistent ? scratchInfo.scratched : [];

    // ういち買い6点抽出
    const uichiVals = UICHI_COMBOS.map((c) => allOdds[c]);
    const allValid = uichiVals.every((v) => v != null && v > 1);
    const synth = allValid ? syntheticOdds(uichiVals) : null;

    const now = new Date().toISOString();
    const venueName = VENUE_NAMES[jcd] || jcd;

    // Race upsert（共通モジュールで重複作成を防止）
    const raceData = {
      race_date: raceDate,
      venue_code: jcd,
      venue_name: venueName,
      race_number: raceNumber,
      race_name: parsed.raceName,
      deadline: parsed.deadline,
      status: "scheduled",
      data_source: "official",
      last_updated: now,
      entries_fetched_at: now,
      odds_fetched_at: now,
    };
    const race = await upsertRace(base44, raceData);

    // RaceEntry 再保存。
    // 直前情報Workerが先に保存した展示タイム/ST/進入/欠場を、オッズ取得で消さない。
    const previousEntries = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: race.id }, 'boat_number', 20).catch(() => []);
    const previousByBoat = Object.fromEntries(previousEntries.map(e => [Number(e.boat_number), e]));
    await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: race.id });
    const entryRecords = parsed.entries.map((e) => {
      const prev = previousByBoat[Number(e.boat_number)] || {};
      return {
        ...e,
        entry_course: prev.entry_course ?? e.entry_course ?? null,
        exhibition_time: prev.exhibition_time ?? e.exhibition_time ?? null,
        exhibition_rank: prev.exhibition_rank ?? e.exhibition_rank ?? null,
        exhibition_st: prev.exhibition_st ?? e.exhibition_st ?? null,
        exhibition_st_raw: prev.exhibition_st_raw ?? e.exhibition_st_raw ?? null,
        tilt: prev.tilt ?? e.tilt ?? null,
        is_scratched: prev.is_scratched === true || e.is_scratched === true,
        race_id: race.id,
        race_date: raceDate,
        venue_code: jcd,
        race_number: raceNumber,
      };
    });
    await base44.asServiceRole.entities.RaceEntry.bulkCreate(entryRecords);

    // OddsSnapshot 保存
    const oddsRecord = {
      race_id: race.id,
      race_date: raceDate,
      captured_at: now,
      stage: "initial",
      odds_1_2_5: allOdds["1-2-5"] ?? null,
      odds_1_2_6: allOdds["1-2-6"] ?? null,
      odds_1_3_5: allOdds["1-3-5"] ?? null,
      odds_1_3_6: allOdds["1-3-6"] ?? null,
      odds_1_4_5: allOdds["1-4-5"] ?? null,
      odds_1_4_6: allOdds["1-4-6"] ?? null,
      synthetic_odds: synth,
      all_trifecta_odds: allOdds,
      scratched_boats: scratchedBoats,
      has_scratch: scratchedBoats.length > 0,
    };
    await base44.asServiceRole.entities.OddsSnapshot.create(oddsRecord);

    // 保存後のRaceをDBから再取得して展示情報状態を正確に返す。
    const savedRace = await base44.asServiceRole.entities.Race.get(race.id).catch(() => race);

    return Response.json({
      status: "success",
      race: savedRace,
      entries: entryRecords.length,
      odds_count: oddsCount,
      uichi: {
        "1-2-5": allOdds["1-2-5"],
        "1-2-6": allOdds["1-2-6"],
        "1-3-5": allOdds["1-3-5"],
        "1-3-6": allOdds["1-3-6"],
        "1-4-5": allOdds["1-4-5"],
        "1-4-6": allOdds["1-4-6"],
      },
      synthetic_odds: synth,
      captured_at: now,
      cached: false,
      retry_count: Math.max(rlFetched.attempt || 0, odFetched.attempt || 0),
      scratched_boats: scratchedBoats,
      has_scratch: scratchedBoats.length > 0,
      exhibition_ready: savedRace?.exhibition_ready === true,
      beforeinfo_fetched_at: savedRace?.beforeinfo_fetched_at ?? null,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}