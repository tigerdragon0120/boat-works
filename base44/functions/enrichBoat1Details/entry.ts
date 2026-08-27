import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { VENUE_NAMES, parseRacelist, sleep, fetchWithTimeout } from "../../shared/scraper.js";

// BOAT WORKS 1号艇詳細データ補完（第2段階・高速化版）
// 第1段階で保存済みのRaceResultに対し、各レースのracelistページから
// 1号艇の出走表データを取得して補完する。
//
// 高速化仕様:
// - 通常モード: 1開催場につき最大3レース並列（Promise.allSettled）
// - エラーモード: 1開催場につき最大2レース並列・長タイムアウト・3回リトライ
// - 300ms毎レース待機 → 廃止（グループ間250ms待機に変更）
// - done済みは完全スキップ
// - RacerSnapshotキャッシュでnational系項目を補完（local/motorは除外）
// - errorが1件でもあればdetail_fetch_statusをdoneにしない

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

    // 並列設定: エラーモードは低並列・長タイムアウト・多リトライ
    const raceConcurrency = errorMode ? 2 : 3;
    const fetchTimeoutMs = errorMode ? 25000 : 15000;
    const maxRetries = errorMode ? 3 : 2;
    const retryDelayMs = errorMode ? 2000 : 1500;
    const groupDelayMs = 250;

    // FetchProgress を processing に更新（重複整理付き）
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

    // 補完対象のRaceResultを取得
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

    // 補完対象を選択
    let pending;
    if (errorMode) {
      // エラー再取得モード: boat1_detail_status = "error" のみ
      pending = allResults.filter(r => r.boat1_detail_status === "error");
    } else if (raceNumbers && raceNumbers.length > 0) {
      // 指定レース番号: pendingのみ（doneはスキップ）
      pending = allResults.filter(r => raceNumbers.includes(r.race_number) &&
        (!r.boat1_detail_status || r.boat1_detail_status === "pending") && !r.boat1_racer_name);
    } else {
      // 通常モード: pending or 未設定かつ racer_name 無し（doneは完全スキップ）
      pending = allResults.filter(r =>
        (!r.boat1_detail_status || r.boat1_detail_status === "pending") && !r.boat1_racer_name
      );
    }
    pending = pending.slice(0, limit);

    if (pending.length === 0) {
      // 0件でもエラー有無を確認してからdone判定
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
      return Response.json({ status: "success", enriched: 0, errors: 0, pending: pendingCount, error_count: errorCount, venue: venueName, date: raceDate });
    }

    let enriched = 0;
    let errors = 0;
    const toUpdate = [];
    const parsedResults = []; // RacerSnapshot補完用

    // レースをraceConcurrency件ずつ並列処理（Promise.allSettledで1件失敗でも他は継続）
    for (let i = 0; i < pending.length; i += raceConcurrency) {
      const batch = pending.slice(i, i + raceConcurrency);

      const batchResults = await Promise.allSettled(batch.map(async (r) => {
        const racelistUrl = `${RACELIST_BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`;
        let lastError = null;
        let parsed = null;

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

        if (!parsed) {
          return { id: r.id, status: "error", error: lastError };
        }

        const b1 = parsed.entries.find((e) => e.boat_number === 1) || null;
        if (!b1) {
          return { id: r.id, status: "error", error: "boat1 not found" };
        }

        return { id: r.id, status: "done", b1 };
      }));

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          const val = result.value;
          if (val.status === "done") {
            parsedResults.push(val);
          } else {
            toUpdate.push({ id: val.id, boat1_detail_status: "error" });
            errors++;
          }
        }
      }

      // グループ間待機（最後のグループ以外）
      if (i + raceConcurrency < pending.length) {
        await sleep(groupDelayMs);
      }
    }

    // RacerSnapshotキャッシュ: 取得成功したレースの登録番号を収集して並列取得
    const regNumbers = [...new Set(parsedResults.map(r => r.b1.registration_number).filter(Boolean))];
    const snapshotCache = {};
    if (regNumbers.length > 0) {
      const snapResults = await Promise.allSettled(
        regNumbers.map(regNum =>
          base44.asServiceRole.entities.RacerSnapshot.filter({ registration_number: regNum }, "-snapshot_date", 1)
        )
      );
      snapResults.forEach((result, i) => {
        if (result.status === "fulfilled" && result.value.length > 0) {
          snapshotCache[regNumbers[i]] = result.value[0];
        }
      });
    }

    // RaceResult更新データ構築（Snapshotキャッシュでnational系項目を補完・local/motorは除外）
    for (const pr of parsedResults) {
      const b1 = pr.b1;
      const snap = snapshotCache[b1.registration_number];
      const update = {
        id: pr.id,
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

      // キャッシュから補完（racelistから取得できなかった項目のみ・local/motorは除外）
      if (snap) {
        if (update.boat1_registration_number === null && snap.registration_number) update.boat1_registration_number = snap.registration_number;
        if (update.boat1_racer_name === null && snap.racer_name) update.boat1_racer_name = snap.racer_name;
        if (update.boat1_grade_class === null && snap.grade_class) update.boat1_grade_class = snap.grade_class;
        if (update.boat1_national_win_rate === null && snap.national_win_rate != null) update.boat1_national_win_rate = snap.national_win_rate;
        if (update.boat1_national_2rate === null && snap.national_2rate != null) update.boat1_national_2rate = snap.national_2rate;
        if (update.boat1_national_3rate === null && snap.national_3rate != null) update.boat1_national_3rate = snap.national_3rate;
        if (update.boat1_avg_st === null && snap.avg_st != null) update.boat1_avg_st = snap.avg_st;
        if (update.boat1_f_count === null && snap.f_count != null) update.boat1_f_count = snap.f_count;
      }

      toUpdate.push(update);
      enriched++;
    }

    if (toUpdate.length > 0) {
      await base44.asServiceRole.entities.RaceResult.bulkUpdate(toUpdate);
    }

    // 全件補完完了したか確認（error含む・errorが1件でもあればdoneにしない）
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

    return Response.json({
      status: "success",
      enriched,
      errors,
      pending: pendingCount,
      error_count: errorCount,
      venue: venueName,
      date: raceDate,
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