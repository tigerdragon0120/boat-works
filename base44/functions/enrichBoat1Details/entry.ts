import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { VENUE_NAMES, parseRacelist, parseRaceIndexHayami, sleep, fetchWithTimeout } from "../../shared/scraper.js";

// BOAT WORKS 1号艇詳細データ補完（第2段階・キャッシュ高速化V2）
//
// 最重要目的: 公式サイトへのHTTPアクセス回数を大幅削減（目標50-70%削減）
//
// 新方式の流れ:
// 1. raceindexページを1HTTP取得 → 早見テーブルで全レース全選手の登録番号を把握
// 2. RacerVenueSnapshot（同日・同場キャッシュ）を一括取得 → メモリMap
// 3. RacerSnapshot（全国データキャッシュ）を一括取得 → メモリMap
// 4. 各pendingレースについて、早見テーブルから1号艇登録番号を特定 → キャッシュ確認
// 5. キャッシュヒット → DBのみで補完（HTTP不要）
// 6. キャッシュミス → racelist取得 → 6艇全員をキャッシュ → 他レースの1号艇補完に再利用
//
// データ精度ルール:
// - local系・motor系は同日・同場キャッシュ(RacerVenueSnapshot)のみ使用
// - national系はRacerSnapshot（別日・別場でもOK）を使用
// - done済みRaceResultは絶対に変更しない
// - errorは通常補完対象外（別処理で再取得）

const RACELIST_BASE = "https://boatrace.jp/owpc/pc/race";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    const jcd = String(body.jcd || body.venue_code || "").padStart(2, "0");
    const raceNumbers = body.race_numbers || null;
    const limit = body.limit || 12;
    const errorMode = body.error_mode || false;

    if (!raceDate || !jcd) {
      return Response.json({ status: "error", message: "race_date, jcd が必要です" }, { status: 400 });
    }

    const hd = raceDate.replace(/-/g, "");
    const venueName = VENUE_NAMES[jcd] || jcd;
    const now = new Date().toISOString();

    const fetchTimeoutMs = errorMode ? 25000 : 15000;
    const maxRetries = errorMode ? 3 : 2;
    const retryDelayMs = errorMode ? 2000 : 1500;
    const groupDelayMs = 250;

    // === FetchProgress管理（重複整理付き） ===
    const existingProgress = await base44.asServiceRole.entities.FetchProgress.filter({
      race_date: raceDate, venue_code: jcd
    });
    let progressId;
    if (existingProgress.length > 1) {
      const sorted = [...existingProgress].sort((a, b) =>
        (b.processed_at || "").localeCompare(a.processed_at || "")
      );
      progressId = sorted[0].id;
      for (let i = 1; i < sorted.length; i++) {
        await base44.asServiceRole.entities.FetchProgress.delete(sorted[i].id);
      }
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        detail_fetch_status: "processing", detail_processed_at: now
      });
    } else if (existingProgress.length === 1) {
      await base44.asServiceRole.entities.FetchProgress.update(existingProgress[0].id, {
        detail_fetch_status: "processing", detail_processed_at: now
      });
      progressId = existingProgress[0].id;
    } else {
      const p = await base44.asServiceRole.entities.FetchProgress.create({
        race_date: raceDate, venue_code: jcd, venue_name: venueName,
        detail_fetch_status: "processing", detail_processed_at: now,
      });
      progressId = p.id;
    }

    // === RaceResult取得 ===
    const allResults = await base44.asServiceRole.entities.RaceResult.filter({
      race_date: raceDate, venue_code: jcd, data_source: "official"
    }, "race_number", 20);

    // 旧データ移行: boat1_racer_name があるが boat1_detail_status 未設定 → "done"
    const legacyDone = allResults.filter(r => !r.boat1_detail_status && r.boat1_racer_name);
    if (legacyDone.length > 0) {
      await base44.asServiceRole.entities.RaceResult.bulkUpdate(
        legacyDone.map(r => ({ id: r.id, boat1_detail_status: "done" }))
      );
    }

    // 補完対象選択
    let pending;
    if (errorMode) {
      pending = allResults.filter(r => r.boat1_detail_status === "error");
    } else if (raceNumbers && raceNumbers.length > 0) {
      pending = allResults.filter(r => raceNumbers.includes(r.race_number) &&
        (!r.boat1_detail_status || r.boat1_detail_status === "pending") && !r.boat1_racer_name);
    } else {
      pending = allResults.filter(r =>
        (!r.boat1_detail_status || r.boat1_detail_status === "pending") && !r.boat1_racer_name
      );
    }
    pending = pending.slice(0, limit);

    if (pending.length === 0) {
      const stillAll = await base44.asServiceRole.entities.RaceResult.filter({
        race_date: raceDate, venue_code: jcd, data_source: "official"
      }, "race_number", 20);
      const pendingCount = stillAll.filter(r =>
        (!r.boat1_detail_status || r.boat1_detail_status === "pending") && !r.boat1_racer_name
      ).length;
      const errorCount = stillAll.filter(r => r.boat1_detail_status === "error").length;
      const detailStatus = (errorCount === 0 && pendingCount === 0) ? "done" : (errorCount > 0 ? "error" : "processing");
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        detail_fetch_status: detailStatus, detail_processed_at: now
      });
      return Response.json({
        status: "success", enriched: 0, errors: 0, pending: pendingCount,
        error_count: errorCount, venue: venueName, date: raceDate,
        http_fetches: 0, cache_completes: 0, cache_hit_rate: 0
      });
    }

    // 統計変数
    let httpFetches = 0;
    let cacheCompletes = 0;
    let enriched = 0;
    let errors = 0;
    const toUpdate = [];
    const racerVenueSnapsToCreate = [];
    const racerVenueSnapsToUpdate = [];
    const racerSnapsToCreate = [];

    // === Step 1: raceindexページ取得 → 早見テーブルパース ===
    let hayamiMap = null;
    const raceIndexUrl = `${RACELIST_BASE}/raceindex?jcd=${jcd}&hd=${hd}`;
    try {
      const riRes = await fetchWithTimeout(raceIndexUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, fetchTimeoutMs);
      if (riRes.ok) {
        const riHtml = await riRes.text();
        hayamiMap = parseRaceIndexHayami(riHtml);
        httpFetches++;
      }
    } catch (e) {
      // raceindex取得失敗 → フォールバック（個別racelist取得）
    }

    // === Step 2: RacerVenueSnapshot一括取得（同日・同場キャッシュ） ===
    const venueCache = new Map(); // key: registration_number → snapshot data
    const existingSnapshots = await base44.asServiceRole.entities.RacerVenueSnapshot.filter({
      snapshot_date: raceDate, venue_code: jcd
    });
    for (const s of existingSnapshots) {
      venueCache.set(s.registration_number, s);
    }

    // === Step 3: RacerSnapshot一括取得（全国データキャッシュ） ===
    const nationalCache = new Map();
    const allRegNums = new Set();
    if (hayamiMap) {
      for (const racers of Object.values(hayamiMap)) {
        for (const r of racers) {
          if (r.registration_number) allRegNums.add(r.registration_number);
        }
      }
    }
    for (const r of allResults) {
      if (r.boat1_registration_number) allRegNums.add(r.boat1_registration_number);
    }

    if (allRegNums.size > 0) {
      const regNumList = [...allRegNums];
      const snapResults = await Promise.all(
        regNumList.map(regNum =>
          base44.asServiceRole.entities.RacerSnapshot.filter(
            { registration_number: regNum }, "-snapshot_date", 1
          )
        )
      );
      snapResults.forEach((result, i) => {
        if (result.length > 0) {
          nationalCache.set(regNumList[i], result[0]);
        }
      });
    }

    // === ヘルパー関数 ===
    function hasAllVenueFields(snap) {
      return snap &&
        snap.local_win_rate != null &&
        snap.local_2rate != null &&
        snap.local_3rate != null &&
        snap.motor_2rate != null &&
        snap.motor_3rate != null;
    }

    function hasAllNationalFields(snap) {
      return snap &&
        snap.national_win_rate != null &&
        snap.national_2rate != null &&
        snap.national_3rate != null &&
        snap.avg_st != null &&
        snap.f_count != null;
    }

    function buildUpdateFromCache(raceResultId, regNum, hayamiBoat1, venueSnap, nationalSnap) {
      return {
        id: raceResultId,
        boat1_detail_status: "done",
        boat1_registration_number: regNum,
        boat1_racer_name: venueSnap?.racer_name || nationalSnap?.racer_name || hayamiBoat1?.racer_name || null,
        boat1_grade_class: venueSnap?.grade_class || nationalSnap?.grade_class || hayamiBoat1?.grade_class || null,
        boat1_national_win_rate: nationalSnap?.national_win_rate ?? null,
        boat1_national_2rate: nationalSnap?.national_2rate ?? null,
        boat1_national_3rate: nationalSnap?.national_3rate ?? null,
        boat1_local_win_rate: venueSnap?.local_win_rate ?? null,
        boat1_local_2rate: venueSnap?.local_2rate ?? null,
        boat1_local_3rate: venueSnap?.local_3rate ?? null,
        boat1_avg_st: nationalSnap?.avg_st ?? null,
        boat1_f_count: nationalSnap?.f_count ?? null,
        boat1_motor_2rate: venueSnap?.motor_2rate ?? null,
        boat1_motor_3rate: venueSnap?.motor_3rate ?? null,
      };
    }

    function buildUpdateFromEntry(raceResultId, b1) {
      return {
        id: raceResultId,
        boat1_detail_status: "done",
        boat1_registration_number: b1.registration_number ?? null,
        boat1_racer_name: b1.racer_name ?? null,
        boat1_grade_class: b1.grade_class ?? null,
        boat1_national_win_rate: b1.national_win_rate ?? null,
        boat1_national_2rate: b1.national_2rate ?? null,
        boat1_national_3rate: b1.national_3rate ?? null,
        boat1_local_win_rate: b1.local_win_rate ?? null,
        boat1_local_2rate: b1.local_2rate ?? null,
        boat1_local_3rate: b1.local_3rate ?? null,
        boat1_avg_st: b1.avg_st ?? null,
        boat1_f_count: b1.f_count ?? null,
        boat1_motor_2rate: b1.motor_2rate ?? null,
        boat1_motor_3rate: b1.motor_3rate ?? null,
      };
    }

    function cacheEntry(entry) {
      if (!entry.registration_number) return;

      const venueSnapData = {
        snapshot_date: raceDate,
        venue_code: jcd,
        registration_number: entry.registration_number,
        racer_name: entry.racer_name,
        grade_class: entry.grade_class,
        local_win_rate: entry.local_win_rate,
        local_2rate: entry.local_2rate,
        local_3rate: entry.local_3rate,
        motor_number: entry.motor_number,
        motor_2rate: entry.motor_2rate,
        motor_3rate: entry.motor_3rate,
        boat_number_id: entry.boat_number_id,
        boat_2rate: entry.boat_2rate,
        boat_3rate: entry.boat_3rate,
      };

      const existing = venueCache.get(entry.registration_number);
      if (existing && existing.id) {
        // DB由来 → bulkUpdate
        racerVenueSnapsToUpdate.push({ id: existing.id, ...venueSnapData });
        venueCache.set(entry.registration_number, { ...venueSnapData, id: existing.id });
      } else if (!existing) {
        // 新規 → bulkCreate
        racerVenueSnapsToCreate.push(venueSnapData);
        venueCache.set(entry.registration_number, venueSnapData);
      }
      // existing だが id 無し（同一バッチ内で既にcreate済み）→ 何もしない

      // 全国データキャッシュ（RacerSnapshot）
      if (!nationalCache.has(entry.registration_number)) {
        const nationalData = {
          registration_number: entry.registration_number,
          snapshot_date: raceDate,
          racer_name: entry.racer_name,
          grade_class: entry.grade_class,
          national_win_rate: entry.national_win_rate,
          national_2rate: entry.national_2rate,
          national_3rate: entry.national_3rate,
          avg_st: entry.avg_st,
          f_count: entry.f_count,
        };
        racerSnapsToCreate.push(nationalData);
        nationalCache.set(entry.registration_number, nationalData);
      }
    }

    // キャッシュから補完できるか確認
    function tryCompleteFromCache(r) {
      const hayami = hayamiMap?.[r.race_number];
      const boat1Info = hayami?.find(h => h.boat_number === 1);
      const regNum = r.boat1_registration_number || boat1Info?.registration_number;

      if (!regNum) return false;

      const venueSnap = venueCache.get(regNum);
      const nationalSnap = nationalCache.get(regNum);

      if (hasAllVenueFields(venueSnap) && hasAllNationalFields(nationalSnap)) {
        toUpdate.push(buildUpdateFromCache(r.id, regNum, boat1Info, venueSnap, nationalSnap));
        cacheCompletes++;
        enriched++;
        return true;
      }
      return false;
    }

    // === Step 4: 1回目のキャッシュパス（全pendingレース） ===
    let remaining = [];
    for (const r of pending) {
      if (!tryCompleteFromCache(r)) {
        remaining.push(r);
      }
    }

    // === Step 5: キャッシュミスのレースを1件ずつracelist取得 ===
    while (remaining.length > 0) {
      // 前回のfetchでキャッシュ追加された可能性があるので再確認
      const stillNeedHttp = [];
      for (const r of remaining) {
        if (!tryCompleteFromCache(r)) {
          stillNeedHttp.push(r);
        }
      }
      remaining = stillNeedHttp;

      if (remaining.length === 0) break;

      // 先頭のレースのracelistを取得
      const r = remaining[0];
      const racelistUrl = `${RACELIST_BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`;
      let parsed = null;
      let lastError = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const rcRes = await fetchWithTimeout(racelistUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, fetchTimeoutMs);
          if (rcRes.ok) {
            const rcHtml = await rcRes.text();
            parsed = parseRacelist(rcHtml, r.race_number, raceDate);
            break;
          }
          lastError = `HTTP ${rcRes.status}`;
        } catch (e) {
          lastError = e.message;
        }
        if (attempt < maxRetries) await sleep(retryDelayMs);
      }

      httpFetches++;

      if (!parsed || !parsed.entries || parsed.entries.length === 0) {
        toUpdate.push({ id: r.id, boat1_detail_status: "error" });
        errors++;
        remaining = remaining.slice(1);
        continue;
      }

      // 6艇全員をキャッシュ
      for (const entry of parsed.entries) {
        cacheEntry(entry);
      }

      // 現在のレースを補完
      const b1 = parsed.entries.find(e => e.boat_number === 1);
      if (b1) {
        toUpdate.push(buildUpdateFromEntry(r.id, b1));
        enriched++;
      } else {
        toUpdate.push({ id: r.id, boat1_detail_status: "error" });
        errors++;
      }

      remaining = remaining.slice(1);

      // 次のfetch前に待機
      if (remaining.length > 0) {
        await sleep(groupDelayMs);
      }
    }

    // === Step 6: 一括書き込み ===
    if (toUpdate.length > 0) {
      await base44.asServiceRole.entities.RaceResult.bulkUpdate(toUpdate);
    }
    if (racerVenueSnapsToCreate.length > 0) {
      await base44.asServiceRole.entities.RacerVenueSnapshot.bulkCreate(racerVenueSnapsToCreate);
    }
    if (racerVenueSnapsToUpdate.length > 0) {
      await base44.asServiceRole.entities.RacerVenueSnapshot.bulkUpdate(racerVenueSnapsToUpdate);
    }
    if (racerSnapsToCreate.length > 0) {
      await base44.asServiceRole.entities.RacerSnapshot.bulkCreate(racerSnapsToCreate);
    }

    // === Step 7: FetchProgress更新 + 統計返却 ===
    const stillAll = await base44.asServiceRole.entities.RaceResult.filter({
      race_date: raceDate, venue_code: jcd, data_source: "official"
    }, "race_number", 20);
    const pendingCount = stillAll.filter(r =>
      (!r.boat1_detail_status || r.boat1_detail_status === "pending") && !r.boat1_racer_name
    ).length;
    const errorCount = stillAll.filter(r => r.boat1_detail_status === "error").length;

    let detailStatus;
    if (pendingCount === 0 && errorCount === 0) {
      detailStatus = "done";
    } else if (pendingCount === 0 && errorCount > 0) {
      detailStatus = "error";
    } else {
      detailStatus = "processing";
    }

    await base44.asServiceRole.entities.FetchProgress.update(progressId, {
      detail_fetch_status: detailStatus, detail_processed_at: now
    });

    const totalProcessed = enriched + errors;
    const cacheHitRate = totalProcessed > 0 ? Math.round((cacheCompletes / totalProcessed) * 100) : 0;

    return Response.json({
      status: "success",
      enriched,
      errors,
      pending: pendingCount,
      error_count: errorCount,
      venue: venueName,
      date: raceDate,
      http_fetches: httpFetches,
      cache_completes: cacheCompletes,
      cache_hit_rate: cacheHitRate,
    });
  } catch (error) {
    try {
      const base44 = createClientFromRequest(req);
      const body = await req.json().catch(() => ({}));
      const raceDate = body.race_date;
      const jcd = String(body.jcd || body.venue_code || "").padStart(2, "0");
      if (raceDate && jcd) {
        const ep = await base44.asServiceRole.entities.FetchProgress.filter({ race_date: raceDate, venue_code: jcd });
        if (ep.length > 0) {
          await base44.asServiceRole.entities.FetchProgress.update(ep[0].id, {
            detail_fetch_status: "error", detail_processed_at: new Date().toISOString()
          });
        }
      }
    } catch {}
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}