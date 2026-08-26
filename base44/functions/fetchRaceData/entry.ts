import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS, syntheticOdds } from "../../shared/uichi.js";
import { VENUE_NAMES, toNum, toFloat, parseRacelist } from "../../shared/scraper.js";

// BOAT WORKS 公式サイト実データ取得関数
// BOAT RACE公式サイト(boatrace.jp)から出走表・3連単オッズを取得しDBへ保存する。
// 公式サイトへのアクセスはここに集約。フロントエンドはDBを見るだけ。
// 取得失敗時は架空データを作らずエラーを返す。

const BASE = "https://boatrace.jp/owpc/pc/race";

// 3連単オッズパース（120通り）
function parseOdds3t(html) {
  const tbodyMatch = html.match(/<tbody class="is-p3-0">([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return {};
  const tbody = tbodyMatch[1];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRe = /<td([^>]*)>([\s\S]*?)<\/td>/g;
  const current2nd = [null, null, null, null, null, null];
  const odds = {};

  let rowMatch;
  while ((rowMatch = rowRe.exec(tbody)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    let cm;
    const re = new RegExp(cellRe.source, "g");
    while ((cm = re.exec(rowHtml)) !== null) {
      cells.push({ attrs: cm[1], content: cm[2] });
    }
    let group = 0;
    let i = 0;
    while (i + 1 < cells.length && group < 6) {
      if (cells[i].attrs.includes("rowspan")) {
        current2nd[group] = toNum(cells[i].content);
        i++;
      }
      const third = toNum(cells[i].content); i++;
      const oddsVal = toFloat(cells[i].content); i++;
      const first = group + 1;
      if (current2nd[group] && third) {
        odds[`${first}-${current2nd[group]}-${third}`] = oddsVal;
      }
      group++;
    }
  }
  return odds;
}

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

    // 出走表取得
    const rlRes = await fetch(racelistUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!rlRes.ok) return Response.json({ status: "error", message: `出走表取得失敗 (HTTP ${rlRes.status})` }, { status: 502 });
    const rlHtml = await rlRes.text();
    if (rlHtml.includes("予期せぬエラーが発生しました")) {
      return Response.json({ status: "error", message: "出走表取得失敗：公式サイトに該当レースが未公開です" }, { status: 502 });
    }
    const parsed = parseRacelist(rlHtml, raceNumber, raceDate);
    if (!parsed.entries.length || parsed.entries.length < 6) {
      return Response.json({ status: "error", message: `出走表取得失敗：${parsed.entries.length}件（6艇未満）` }, { status: 502 });
    }

    // オッズ取得
    const odRes = await fetch(oddsUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!odRes.ok) return Response.json({ status: "error", message: `オッズ取得失敗 (HTTP ${odRes.status})` }, { status: 502 });
    const odHtml = await odRes.text();
    if (odHtml.includes("予期せぬエラーが発生しました")) {
      return Response.json({ status: "error", message: "オッズ取得失敗：公式サイトに該当レースが未公開です" }, { status: 502 });
    }
    const allOdds = parseOdds3t(odHtml);
    const oddsCount = Object.keys(allOdds).length;
    if (oddsCount < 120) {
      return Response.json({ status: "error", message: `オッズ取得失敗：${oddsCount}件（120通り未満）` }, { status: 502 });
    }

    // ういち買い6点抽出
    const uichiVals = UICHI_COMBOS.map((c) => allOdds[c]);
    const allValid = uichiVals.every((v) => v != null && v > 1);
    const synth = allValid ? syntheticOdds(uichiVals) : null;

    const now = new Date().toISOString();
    const venueName = VENUE_NAMES[jcd] || jcd;

    // Race upsert
    const existing = await base44.asServiceRole.entities.Race.filter({
      race_date: raceDate, venue_code: jcd, race_number: raceNumber
    });
    let race;
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
    if (existing.length > 0) {
      race = await base44.asServiceRole.entities.Race.update(existing[0].id, raceData);
    } else {
      race = await base44.asServiceRole.entities.Race.create(raceData);
    }

    // RaceEntry 再保存（古いものを削除）
    await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: race.id });
    const entryRecords = parsed.entries.map((e) => ({
      ...e,
      race_id: race.id,
      race_date: raceDate,
      venue_code: jcd,
      race_number: raceNumber,
    }));
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
    };
    await base44.asServiceRole.entities.OddsSnapshot.create(oddsRecord);

    return Response.json({
      status: "success",
      race,
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
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}