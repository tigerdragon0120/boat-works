// BOAT WORKS 公式サイトスクレイピング共通ロジック
// fetchRaceData / fetchHistoricalResults で共有使用

export const VENUE_NAMES = {
  "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
  "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
  "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
  "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
  "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村"
};

export const ALL_VENUE_JCDS = Object.keys(VENUE_NAMES);

export function stripTags(s) {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&yen;/g, "¥")
    .replace(/\s+/g, " ")
    .trim();
}

export function zenToHalf(s) {
  return (s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

export function toNum(s) {
  const n = parseInt(zenToHalf(stripTags(s)), 10);
  return isNaN(n) ? null : n;
}

export function toFloat(s) {
  const n = parseFloat(zenToHalf(stripTags(s)));
  return isNaN(n) ? null : n;
}

export function toPayout(s) {
  const cleaned = zenToHalf(stripTags(s)).replace(/[¥￥,円\s]/g, "");
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? null : n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// 出走表パース（1レース分）
export function parseRacelist(html, raceNumber, raceDate) {
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

  let raceName = null;
  const nmMatch = html.match(/<h3[^>]*class="title16[^"]*"[^>]*>([\s\S]*?)<\/h3>/);
  if (nmMatch) raceName = stripTags(nmMatch[1]);

  const entries = [];
  const tbodyRe = /<tbody\s+class="[^"]*is-fs12[^"]*">([\s\S]*?)<\/tbody>/g;
  let tbodyMatch;
  while ((tbodyMatch = tbodyRe.exec(html)) !== null) {
    const tbody = tbodyMatch[1];
    const tdRe = /<td([^>]*)rowspan="4"[^>]*>([\s\S]*?)<\/td>/g;
    const tds = [];
    let m;
    while ((m = tdRe.exec(tbody)) !== null) tds.push({ attrs: m[1], content: m[2] });

    const i = tds.findIndex((t) => t.attrs.includes("is-boatColor") && t.attrs.includes("is-fs14"));
    if (i < 0 || i + 7 >= tds.length) continue;
    const boatNum = toNum(tds[i].content);
    const info = tds[i + 2].content;
    const flst = tds[i + 3].content;
    const nat = tds[i + 4].content;
    const loc = tds[i + 5].content;
    const motor = tds[i + 6].content;
    const boatEq = tds[i + 7].content;

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

// 1日の開催場一覧パース（トップページHTMLからjcd一覧を抽出）
export function parseDailyVenueList(html) {
  const jcds = new Set();
  const re = /jcd=(\d{2})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    jcds.add(m[1]);
  }
  return Array.from(jcds).sort();
}

// 1日のレース一覧パース（raceindexページから各レース番号と締切時刻を抽出）
// raceindex?jcd=XX&hd=YYYYMMDD のページ構造:
//   <tr> ... <a href="...racelist?rno=1&jcd=18&hd=...">1R</a> ... >08:40< ... </tr>
export function parseDaySchedule(html, raceDate) {
  const races = [];
  const seen = new Set();
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const rnoMatch = row.match(/racelist\?rno=(\d+)/);
    if (!rnoMatch) continue;
    const raceNumber = parseInt(rnoMatch[1], 10);
    if (seen.has(raceNumber)) continue;
    seen.add(raceNumber);
    const timeMatch = row.match(/>\s*(\d{2}:\d{2})\s*</);
    const deadline = timeMatch ? `${raceDate}T${timeMatch[1]}:00+09:00` : null;
    races.push({ race_number: raceNumber, deadline });
  }
  return races;
}

// 結果一覧ページパース（1日1場分の全レース結果）
// 3連単組合わせと払戻金を抽出
export function parseResultList(html) {
  const results = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const rnoMatch = row.match(/raceresult\?rno=(\d+)/);
    if (!rnoMatch) continue;
    const raceNumber = parseInt(rnoMatch[1], 10);

    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let cm;
    while ((cm = cellRe.exec(row)) !== null) cells.push(cm[1]);
    if (cells.length < 3) continue;

    // 3連単セル: "1<br>-4<br>-5" → "1-4-5"
    const trifectaRaw = stripTags(cells[1]).replace(/\s+/g, "");
    if (!/^\d-\d-\d$/.test(trifectaRaw)) continue;

    const [a, b, c] = trifectaRaw.split("-").map(Number);
    const payout = toPayout(cells[2]);

    results.push({
      race_number: raceNumber,
      trifecta: trifectaRaw,
      result_1: a,
      result_2: b,
      result_3: c,
      payout_trifecta: payout,
    });
  }
  return results;
}