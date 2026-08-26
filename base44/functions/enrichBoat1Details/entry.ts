import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { VENUE_NAMES, parseRacelist, sleep } from "../../shared/scraper.js";

// BOAT WORKS 1号艇詳細データ補完（第2段階）
// 第1段階で保存済みのRaceResultに対し、各レースのracelistページから
// 1号艇の出走表データを取得して補完する。
// 優先順位: 直近日付 > ういち的中 > その他（呼び出し側で制御）

const RACELIST_BASE = "https://boatrace.jp/owpc/pc/race";
const REQUEST_DELAY_MS = 300;

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    const jcd = String(body.jcd || body.venue_code || "").padStart(2, "0");
    const raceNumbers = body.race_numbers || null; // 指定時はそのレースのみ
    const limit = body.limit || 12;

    if (!raceDate || !jcd) {
      return Response.json({ status: "error", message: "race_date, jcd が必要です" }, { status: 400 });
    }

    const hd = raceDate.replace(/-/g, "");
    const venueName = VENUE_NAMES[jcd] || jcd;
    const now = new Date().toISOString();

    // FetchProgress を processing に更新（重複整理付き）
    const existingProgress = await base44.asServiceRole.entities.FetchProgress.filter({
      race_date: raceDate, venue_code: jcd
    });
    let progressId;
    if (existingProgress.length > 1) {
      // 重複FetchProgress: 最新1件を残し残り削除
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

    // 旧データの移行: boat1_racer_name があるが boat1_detail_status 未設定のレコードを "done" に一括更新
    const legacyDone = allResults.filter(r => !r.boat1_detail_status && r.boat1_racer_name);
    if (legacyDone.length > 0) {
      await base44.asServiceRole.entities.RaceResult.bulkUpdate(
        legacyDone.map(r => ({ id: r.id, boat1_detail_status: "done" }))
      );
    }

    // 真に補完が必要なレコード: boat1_detail_status が pending/null かつ boat1_racer_name 無し
    let pending = allResults.filter(r =>
      (!r.boat1_detail_status || r.boat1_detail_status === "pending") && !r.boat1_racer_name
    );
    // race_numbers指定時はそのレースのみ（強制補完）
    if (raceNumbers && raceNumbers.length > 0) {
      pending = allResults.filter(r => raceNumbers.includes(r.race_number));
    }
    pending = pending.slice(0, limit);

    if (pending.length === 0) {
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        detail_fetch_status: "done", detail_processed_at: now
      });
      return Response.json({ status: "success", enriched: 0, venue: venueName, date: raceDate });
    }

    let enriched = 0;
    let errors = 0;
    const toUpdate = [];

    for (const r of pending) {
      await sleep(REQUEST_DELAY_MS);
      const racelistUrl = `${RACELIST_BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`;
      try {
        const rcRes = await fetch(racelistUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (rcRes.ok) {
          const rcHtml = await rcRes.text();
          const parsed = parseRacelist(rcHtml, r.race_number, raceDate);
          const b1 = parsed.entries.find((e) => e.boat_number === 1) || null;
          if (b1) {
            toUpdate.push({
              id: r.id,
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
            });
            enriched++;
          } else {
            toUpdate.push({ id: r.id, boat1_detail_status: "error" });
            errors++;
          }
        } else {
          toUpdate.push({ id: r.id, boat1_detail_status: "error" });
          errors++;
        }
      } catch {
        toUpdate.push({ id: r.id, boat1_detail_status: "error" });
        errors++;
      }
    }

    if (toUpdate.length > 0) {
      await base44.asServiceRole.entities.RaceResult.bulkUpdate(toUpdate);
    }

    // 全件補完完了したか確認
    const stillAll = await base44.asServiceRole.entities.RaceResult.filter({
      race_date: raceDate, venue_code: jcd, data_source: "official"
    }, "race_number", 20);
    const pendingCount = stillAll.filter(r =>
      (!r.boat1_detail_status || r.boat1_detail_status === "pending") && !r.boat1_racer_name
    ).length;
    const detailStatus = pendingCount === 0 ? "done" : "processing";

    await base44.asServiceRole.entities.FetchProgress.update(progressId, {
      detail_fetch_status: detailStatus, detail_processed_at: now
    });

    return Response.json({
      status: "success",
      enriched,
      errors,
      pending: pendingCount,
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