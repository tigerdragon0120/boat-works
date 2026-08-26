import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS, syntheticOdds } from "../../shared/uichi.js";

// BOAT WORKS 公式サイト実データ取得関数
// BOAT RACE公式サイト(boatrace.jp)から出走表・3連単オッズを取得しDBへ保存する。
// 公式サイトへのアクセスはここに集約。フロントエンドはDBを見るだけ。
// 取得失敗時は架空データを作らずエラーを返す。

const VENUE_NAMES = {
  "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
  "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
  "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
  "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
  "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村"
};

const BASE = "https://boatrace.jp/owpc/pc/race";

function stripTags(s) {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function zenToHalf(s) {
  return (s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function toNum(s) {
  const n = parseInt(zenToHalf(stripTags(s)), 10);
  return isNaN(n) ? null : n;
}

function toFloat(s) {
  const n = parseFloat(zenToHalf(stripTags(s)));
  return isNaN(n) ? null : n;
}

// 出走表パース
function parseRacelist(html, raceNumber, raceDate) {
  // 締切時刻
  let deadline = null;
  const dlIdx = html.indexOf("締切予定時刻");
  if (dlIdx >= 0) {
    const section = html.substring(dlIdx, dlIdx + 1500);
    const times = [];
    const re = /<td[^>]*>(\d{2}:\d{2})<\/td>/g;
    let m;
    while ((m = re.exec(section)) !== null && times.length < 12) times.push(m[1]);
    const t = times[raceNumber - 1];
    if (t) deadline = `${raceDate}T${t}:00+09:00`;
  }

  // レース名
  let raceName = null;
  const nmMatch = html.match(/<h3[^>]*class="title16[^"]*"[^>]*>([\s\S]*?)<\/h3>/);
  if (nmMatch) raceName = stripTags(nmMatch[1]);

  // 出走表 tbody（各艇ごとに1tbody）
  const entries = [];
  const tbodyRe = /<tbody\s+class="[^"]*is-fs12[^"]*">([\s\S]*?)<\/tbody>/g;
  let tbodyMatch;
  while ((tbodyMatch = tbodyRe.exec(html)) !== null) {
    const tbody = tbodyMatch[1];
    const tdRe = /<td([^>]*)rowspan="4"[^>]*>([\s\S]*?)<\/td>/g;
    const tds = [];
    let m;
    while ((m = tdRe.exec(tbody)) !== null) tds.push({ attrs: m[1], content: m[2] });

    // boatNum td は is-boatColor + is-fs14 を持つ。次の7tdがデータ
    const i = tds.findIndex((t) => t.attrs.includes("is-boatColor") && t.attrs.includes("is-fs14"));
    if (i < 0 || i + 7 >= tds.length) continue;
    const boatNum = toNum(tds[i].content);
    const info = tds[i + 2].content;
    const flst = tds[i + 3].content;
    const nat = tds[i + 4].content;
    const loc = tds[i + 5].content;
    const motor = tds[i + 6].content;
    const boatEq = tds[i + 7].content;

    // info divs
    const divs = [];
    const dRe = /<div[^>]*>([\s\S]*?)<\/div>/g;
    let dm;
    while ((dm = dRe.exec(info)) !== null) divs.push(dm[1]);

    let regNum = null, grade = null, name = null, branch = null, age = null, weight = null;
    if (divs[0]) {
      const parts = stripTags(divs[0]).split("/");
      regNum = (parts[0] || "").trim() || null;
      grade = (parts[1] || "").trim() || null;
    }
    if (divs[1]) {
      const aMatch = divs[1].match(/<a[^>]*>([\s\S]*?)<\/a>/);
      name = aMatch ? stripTags(aMatch[1]) : stripTags(divs[1]);
    }
    if (divs[2]) {
      const txt = stripTags(divs[2]);
      const bb = txt.split(/\s+/);
      const branchPart = bb[0] || "";
      branch = (branchPart.split("/")[0] || "").trim() || null;
      const awPart = bb[1] || "";
      const ageM = awPart.match(/(\d+)歳/);
      const wtM = awPart.match(/([\d.]+)kg/);
      age = ageM ? Number(ageM[1]) : null;
      weight = wtM ? Number(wtM[1]) : null;
    }

    const flstParts = stripTags(flst).split(/\s+/);
    const fTok = flstParts.find((p) => /^F\d+$/.test(p));
    const lTok = flstParts.find((p) => /^L\d+$/.test(p));
    const stTok = flstParts.find((p) => /^\d+\.\d+$/.test(p));

    const natParts = stripTags(nat).split(/\s+/);
    const locParts = stripTags(loc).split(/\s+/);
    const motorParts = stripTags(motor).split(/\s+/);
    const boatParts = stripTags(boatEq).split(/\s+/);

    entries.push({
      boat_number: boatNum,
      registration_number: regNum,
      racer_name: name,
      grade_class: grade,
      branch,
      age,
      weight,
      national_win_rate: toFloat(natParts[0]),
      national_2rate: toFloat(natParts[1]),
      national_3rate: toFloat(natParts[2]),
      local_win_rate: toFloat(locParts[0]),
      local_2rate: toFloat(locParts[1]),
      local_3rate: toFloat(locParts[2]),
      avg_st: stTok ? Number(stTok) : null,
      f_count: fTok ? Number(fTok.replace("F", "")) : null,
      l_count: lTok ? Number(lTok.replace("L", "")) : null,
      motor_number: toNum(motorParts[0]),
      motor_2rate: toFloat(motorParts[1]),
      motor_3rate: toFloat(motorParts[2]),
      boat_number_id: toNum(boatParts[0]),
      boat_2rate: toFloat(boatParts[1]),
      boat_3rate: toFloat(boatParts[2]),
    });
  }

  return { deadline, raceName, entries };
}

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