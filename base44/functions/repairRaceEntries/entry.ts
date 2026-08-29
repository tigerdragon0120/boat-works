import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { parseRacelist, fetchWithRetry, sleep } from "../../shared/scraper.js";

const BASE = "https://boatrace.jp/owpc/pc/race";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") {
      return Response.json({ status: "error", message: "管理者権限が必要です" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { race_date, race_ids = [] } = body;
    if (!race_date || !Array.isArray(race_ids) || race_ids.length === 0) {
      return Response.json({ status: "error", message: "race_date と race_ids が必要です" }, { status: 400 });
    }

    const idSet = new Set(race_ids);
    const races = await base44.asServiceRole.entities.Race.filter({ race_date, data_source: "official" }, "race_number", 300);
    const targets = races.filter(r => idSet.has(r.id));
    const hd = race_date.replace(/-/g, "");

    let repaired = 0, skipped = 0, errors = 0;
    const completed_ids = [];
    const error_items = [];

    // 既存RaceEntryをまとめて確認し、6艇揃っているレースは外部取得しない
    const existingEntries = await base44.asServiceRole.entities.RaceEntry.filter({ race_date }, "boat_number", 2000);
    const countByRace = {};
    for (const e of existingEntries) countByRace[e.race_id] = (countByRace[e.race_id] || 0) + 1;

    const need = targets.filter(r => (countByRace[r.id] || 0) < 6);
    for (const r of targets) {
      if ((countByRace[r.id] || 0) >= 6) {
        skipped++;
        completed_ids.push(r.id);
      }
    }

    // 欠損レースだけを3件ずつ取得。最大2回試行。
    const BATCH = 3;
    for (let i = 0; i < need.length; i += BATCH) {
      const batch = need.slice(i, i + BATCH);
      await Promise.all(batch.map(async (r) => {
        try {
          const rlUrl = `${BASE}/racelist?rno=${r.race_number}&jcd=${r.venue_code}&hd=${hd}`;
          const rlRes = await fetchWithRetry(rlUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, 10000, 2);
          const rlHtml = await rlRes.text();
          const parsed = parseRacelist(rlHtml, r.race_number, race_date);
          if (!parsed.entries || parsed.entries.length < 6) {
            errors++;
            error_items.push({ race_id: r.id, venue: r.venue_name, race_number: r.race_number, reason: "6艇未取得" });
            return;
          }

          await base44.asServiceRole.entities.Race.update(r.id, {
            race_name: parsed.raceName,
            deadline: parsed.deadline || r.deadline,
            entries_fetched_at: new Date().toISOString(),
          });
          await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: r.id });
          const records = parsed.entries.map(e => ({
            ...e,
            race_id: r.id,
            race_date,
            venue_code: r.venue_code,
            race_number: r.race_number,
          }));
          await base44.asServiceRole.entities.RaceEntry.bulkCreate(records);
          repaired++;
          completed_ids.push(r.id);
        } catch (e) {
          errors++;
          error_items.push({ race_id: r.id, venue: r.venue_name, race_number: r.race_number, reason: e?.message || "取得失敗" });
        }
      }));
      await sleep(250);
    }

    // 修復できたレースはこの関数内で即pre分析まで完了させる。
    // 呼び出し側や10分分析Workerを待たない。
    let analysis = null;
    if (completed_ids.length > 0) {
      try {
        const res = await base44.asServiceRole.functions.invoke("analyzeAllRacesForDate", {
          race_date,
          stage: body.stage || "pre",
          race_ids: [...new Set(completed_ids)],
          force: true,
        });
        analysis = res?.data || res;
      } catch (e) {
        errors++;
        error_items.push({ phase: "analysis", reason: e?.message || "修復後分析失敗" });
      }
    }

    return Response.json({
      status: errors > 0 && repaired === 0 ? "partial" : "success",
      race_date,
      requested: targets.length,
      repaired,
      skipped,
      errors,
      completed_ids,
      analysis,
      error_items,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
