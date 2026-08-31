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

// AbortController付きHTTP fetch（タイムアウト保証）
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// 最大maxRetries回リトライ付きfetch（1秒待機・HTTPエラー/タイムアウト対応）
export async function fetchWithRetry(url, options = {}, timeoutMs = 10000, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) await sleep(1000);
    }
  }
  throw lastError;
}

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

  return { deadline, raceName, racePhase: classifyRacePhase(raceName), entries };
}

// 直前情報パース（展示タイム・スタート展示・気象・欠場）
export function parseBeforeInfo(html) {
  const entries = [];
  const tbodyRe = /<tbody\s+class="[^"]*is-fs12[^"]*">([\s\S]*?)<\/tbody>/g;
  let bm;
  while ((bm = tbodyRe.exec(html)) !== null) {
    const tbody = bm[1];
    const tds = [];
    const tdRe = /<td([^>]*)rowspan="4"[^>]*>([\s\S]*?)<\/td>/g;
    let tm;
    while ((tm = tdRe.exec(tbody)) !== null) tds.push({ attrs: tm[1], content: tm[2] });
    const i = tds.findIndex(t => t.attrs.includes("is-boatColor") && t.attrs.includes("is-fs14"));
    if (i < 0 || i + 4 >= tds.length) continue;
    const boat = toNum(tds[i].content);
    const exhibitionTime = toFloat(tds[i + 3]?.content);
    const tilt = toFloat(tds[i + 4]?.content);
    if (boat) entries.push({ boat_number: boat, exhibition_time: exhibitionTime, tilt });
  }

  // 展示順位（タイムの速い順。同タイムは同順位扱いではなく枠順で安定化）
  const ranked = entries
    .filter(e => e.exhibition_time != null)
    .slice()
    .sort((a,b) => a.exhibition_time - b.exhibition_time || a.boat_number - b.boat_number);
  ranked.forEach((e, idx) => { e.exhibition_rank = idx + 1; });
  const rankMap = Object.fromEntries(ranked.map(e => [e.boat_number, e.exhibition_rank]));

  const startSectionStart = html.indexOf("スタート展示");
  const weatherSectionStart = html.indexOf("水面気象情報");
  const startSection = startSectionStart >= 0
    ? html.substring(startSectionStart, weatherSectionStart > startSectionStart ? weatherSectionStart : startSectionStart + 12000)
    : "";
  const startRows = [];
  const startRe = /table1_boatImage1Number\s+is-type(\d+)">(\d)<\/span>[\s\S]*?table1_boatImage1Time[^>]*>([^<]*)<\/span>/g;
  let sm;
  while ((sm = startRe.exec(startSection)) !== null) {
    const boat = Number(sm[2]);
    const raw = stripTags(sm[3]);
    let st = null;
    if (/^F\.\d+$/.test(raw)) st = -Number(raw.replace("F", "0"));
    else if (/^L\.\d+$/.test(raw)) st = Number(raw.replace("L", "0"));
    else {
      const n = Number(raw.startsWith(".") ? `0${raw}` : raw);
      st = Number.isFinite(n) ? n : null;
    }
    startRows.push({ boat_number: boat, entry_course: startRows.length + 1, exhibition_st: st, exhibition_st_raw: raw || null });
  }
  const startMap = Object.fromEntries(startRows.map(e => [e.boat_number, e]));
  const displayMap = Object.fromEntries(entries.map(e => [e.boat_number, e]));
  const scratchedBoats = [1,2,3,4,5,6].filter(n => {
    const d = displayMap[n];
    return !startMap[n] || !d || d.exhibition_time == null;
  });

  const mergedEntries = [1,2,3,4,5,6].map(n => ({
    boat_number: n,
    exhibition_time: displayMap[n]?.exhibition_time ?? null,
    exhibition_rank: rankMap[n] ?? null,
    tilt: displayMap[n]?.tilt ?? null,
    entry_course: startMap[n]?.entry_course ?? null,
    exhibition_st: startMap[n]?.exhibition_st ?? null,
    exhibition_st_raw: startMap[n]?.exhibition_st_raw ?? null,
    is_scratched: scratchedBoats.includes(n),
  }));

  const getNumberAfter = (label) => {
    const re = new RegExp(`${label}<\\/span>\\s*<span[^>]*>([^<]+)<\\/span>`);
    const m = html.match(re);
    return m ? toFloat(m[1]) : null;
  };
  const weatherMatch = html.match(/weather1_bodyUnit\s+is-weather[\s\S]{0,350}?weather1_bodyUnitLabelTitle">([^<]+)<\/span>/);
  const windBlock = html.match(/weather1_bodyUnit\s+is-wind[\s\S]{0,500}?weather1_bodyUnitLabelTitle">([^<]+)<\/span>/i);
  const windDirText = windBlock ? stripTags(windBlock[1]) : null;

  return {
    entries: mergedEntries,
    scratched_boats: scratchedBoats,
    exhibition_ready: mergedEntries.some(e => e.exhibition_time != null) && startRows.length >= 3,
    weather: weatherMatch ? stripTags(weatherMatch[1]) : null,
    wind_dir: windDirText || null,
    wind_speed: getNumberAfter("風速"),
    air_temperature: getNumberAfter("気温"),
    water_temperature: getNumberAfter("水温"),
    wave_height: getNumberAfter("波高"),
  };
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

// raceindexページの早見テーブルをパース（全レース全選手の登録番号・名前・級別を抽出）
// 1HTTPアクセスで1日分の全レース全選手の担当艇番号と登録番号が分かる
// 戻り値: { [raceNumber]: [{ boat_number, registration_number, racer_name, grade_class }, ...6艇] }
export function parseRaceIndexHayami(html) {
  const races = {};
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const rnoMatch = row.match(/racelist\?rno=(\d+)/);
    if (!rnoMatch) continue;
    const raceNumber = parseInt(rnoMatch[1], 10);
    if (races[raceNumber]) continue;

    // 各選手のプロフィールリンクを抽出（boat順）
    const racerRe = /racersearch\/profile\?toban=(\d+)[^>]*>([\s\S]*?)<\/a>/g;
    const racers = [];
    let racerMatch;
    while ((racerMatch = racerRe.exec(row)) !== null && racers.length < 6) {
      const regNum = racerMatch[1];
      const name = stripTags(racerMatch[2]);
      // 級別: リンク直後の <br> の後にある (例: B1, A2)
      const afterLink = row.substring(racerMatch.index + racerMatch[0].length);
      const gradeMatch = afterLink.match(/^\s*(?:<br\s*\/?>)?\s*([A-Z]\d)/);
      racers.push({
        boat_number: racers.length + 1,
        registration_number: regNum,
        racer_name: name,
        grade_class: gradeMatch ? gradeMatch[1] : null,
      });
    }
    if (racers.length === 6) {
      races[raceNumber] = racers;
    }
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

// レース結果詳細ページをパースする。
// 重要: 公式は上位3着だけでなく4着までタイムが出るケースもあるため、
//       「何着まで」と決め打ちせず取得できた全タイムを保存する。
//       1-2着差 / 1-3着差は後段で使いやすいよう秒で別途算出する。
// 開催日程・グレード・開催何日目をraceindexから読む。
export function parseSeriesContext(html, raceDate) {
  const heading = html.match(/<div class="heading2_title\s+([^"]*)"[^>]*>\s*<h2[^>]*class="heading2_titleName"[^>]*>([\s\S]*?)<\/h2>/i);
  const headingClass = (heading?.[1] || '').trim();
  const eventName = heading ? stripTags(heading[2]) : null;
  const hc = headingClass.toLowerCase();
  let grade = 'GENERAL';
  if (hc.includes('sga') || /\bsg\b/i.test(headingClass)) grade = 'SG';
  else if (hc.includes('pg1')) grade = 'PG1';
  else if (hc.includes('g1')) grade = 'G1';
  else if (hc.includes('g2')) grade = 'G2';
  else if (hc.includes('g3')) grade = 'G3';
  else if (hc.includes('ippan')) grade = 'GENERAL';

  const dates = [];
  const tabStart = html.indexOf('tab2 is-type1');
  const tabEnd = tabStart >= 0 ? html.indexOf('</ul>', tabStart) : -1;
  const tabHtml = tabStart >= 0 ? html.substring(tabStart, tabEnd > tabStart ? tabEnd : tabStart + 5000) : '';
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  const base = raceDate ? new Date(`${raceDate}T00:00:00Z`) : new Date();
  while ((m = liRe.exec(tabHtml)) !== null) {
    const label = stripTags(m[1]);
    if (!/(初日|日目|最終日)/.test(label)) continue;
    const z = zenToHalf(label);
    const md = z.match(/(\d{1,2})月(\d{1,2})日/);
    if (!md) continue;
    let year = base.getUTCFullYear();
    const month = Number(md[1]), day = Number(md[2]);
    // 年跨ぎシリーズにも耐えるよう、基準日から最も近い年を採用。
    const candidates = [year - 1, year, year + 1].map(y => ({ y, diff: Math.abs(new Date(Date.UTC(y, month - 1, day)) - base) }));
    year = candidates.sort((a,b)=>a.diff-b.diff)[0].y;
    const hd = `${year}${String(month).padStart(2,'0')}${String(day).padStart(2,'0')}`;
    dates.push({ hd, date: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`, label });
  }
  const idx = dates.findIndex(x => x.date === raceDate);
  return {
    event_name: eventName,
    grade,
    series_dates: dates.map(x=>x.date),
    series_labels: dates.map(x=>x.label),
    series_start_date: dates[0]?.date || raceDate || null,
    series_end_date: dates[dates.length - 1]?.date || raceDate || null,
    series_total_days: dates.length || 1,
    series_day: idx >= 0 ? idx + 1 : null,
    is_final_day: idx >= 0 ? idx === dates.length - 1 : false,
  };
}

export function classifyRacePhase(raceName) {
  const n = String(raceName || '').replace(/\s+/g, '');
  if (!n) return 'OTHER';
  if (n.includes('準優')) return 'SEMIFINAL';
  if (n.includes('優勝戦')) return 'FINAL';
  if (n.includes('ドリーム')) return 'DREAM';
  if (n.includes('選抜')) return 'SELECTION';
  if (n.includes('予選')) return 'QUALIFYING';
  if (n.includes('一般')) return 'GENERAL';
  return 'OTHER';
}

// 公式の得点率一覧。一般開催などページ自体が無い場合はavailable=falseで返し、推測順位を作らない。
export function parsePointRank(html) {
  if (!html || html.includes('※ データはありません')) {
    return { available: false, as_of_label: null, standings: [] };
  }
  const note = html.match(/<ul class="notes2[^>]*>[\s\S]*?<li>([\s\S]*?)<\/li>/);
  const asOfLabel = note ? stripTags(note[1]).split('※')[0].trim() : null;
  const standings = [];
  const bodyRe = /<tbody[^>]*>\s*<tr[^>]*class="[^"]*is-p10-0[^"]*"[^>]*>([\s\S]*?)<\/tr>\s*<\/tbody>/g;
  let bm;
  while ((bm = bodyRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let cm;
    while ((cm = tdRe.exec(bm[1])) !== null) cells.push(cm[1]);
    if (cells.length < 8) continue;
    const regMatch = cells[1].match(/toban=(\d{4})/) || stripTags(cells[1]).match(/(\d{4})/);
    if (!regMatch) continue;
    const rankText = zenToHalf(stripTags(cells[0])).trim();
    const pointRateText = zenToHalf(stripTags(cells[4])).trim();
    const nextRace = (cell) => {
      if (!cell) return null;
      const mm = stripTags(cell).match(/(\d{1,2})R/);
      return mm ? Number(mm[1]) : null;
    };
    standings.push({
      rank: /^\d+$/.test(rankText) ? Number(rankText) : null,
      registration_number: regMatch[1],
      racer_name: stripTags(cells[2]).replace(/\s+/g, ' '),
      grade_class: stripTags(cells[3]) || null,
      point_rate: /^\d+(\.\d+)?$/.test(pointRateText) ? Number(pointRateText) : null,
      finish_record: stripTags(cells[5]).replace(/\s+/g, ''),
      total_points: toFloat(cells[6]),
      penalty_points: toFloat(cells[7]) ?? 0,
      next_race_1: nextRace(cells[8]),
      next_race_2: nextRace(cells[9]),
      note: stripTags(cells[10] || '') || null,
    });
  }
  return { available: standings.length > 0, as_of_label: asOfLabel, standings };
}

export function parseRaceResultDetail(html) {
  if (!html || !html.includes('レースタイム')) return null;

  const normalizeTime = (raw) => {
    const s = String(raw || '').trim();
    const m = s.match(/(\d+)'(\d{2})"(\d)/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10;
  };

  const finishers = [];
  const tableStart = html.indexOf('レースタイム');
  const tableEnd = html.indexOf('スタート情報', tableStart);
  const finishSection = html.substring(tableStart, tableEnd > tableStart ? tableEnd : tableStart + 12000);
  const tbodyRe = /<tbody[^>]*>([\s\S]*?)<\/tbody>/g;
  let tm;
  while ((tm = tbodyRe.exec(finishSection)) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let cm;
    while ((cm = cellRe.exec(tm[1])) !== null) cells.push(cm[1]);
    if (cells.length < 4) continue;
    const finishRaw = stripTags(cells[0]).replace(/\s+/g, '');
    const boat = Number(stripTags(cells[1]).replace(/\D/g, ''));
    const regMatch = cells[2].match(/is-fs12">\s*(\d{4})\s*<\/span>/);
    const nameMatch = cells[2].match(/is-lh24__3rdadd">([^<]+)<\/span>/);
    const timeRaw = stripTags(cells[3]).replace(/\s+/g, '');
    const finishMap = { '１': 1, '２': 2, '３': 3, '４': 4, '５': 5, '６': 6 };
    const finish = finishMap[finishRaw] || Number(finishRaw);
    if (!Number.isFinite(finish) || !Number.isFinite(boat) || boat < 1 || boat > 6) continue;
    finishers.push({
      finish,
      boat_number: boat,
      registration_number: regMatch ? regMatch[1] : null,
      racer_name: nameMatch ? stripTags(nameMatch[1]).replace(/\s+/g, ' ') : null,
      race_time_raw: timeRaw || null,
      race_time_seconds: normalizeTime(timeRaw),
    });
  }
  finishers.sort((a, b) => a.finish - b.finish);

  const startInfo = [];
  const startStart = html.indexOf('スタート情報');
  if (startStart >= 0) {
    const startEnd = html.indexOf('勝式', startStart);
    const startSection = html.substring(startStart, startEnd > startStart ? startEnd : startStart + 12000);
    const rowRe = /table1_boatImage1Number[^>]*>(\d)<\/span>[\s\S]{0,900}?table1_boatImage1TimeInner[^>]*>([\s\S]*?)<\/span>/g;
    let sm;
    while ((sm = rowRe.exec(startSection)) !== null) {
      const boat = Number(sm[1]);
      const rawText = stripTags(sm[2]).replace(/&nbsp;| /g, ' ').trim();
      const stMatch = rawText.match(/F?\.?\d{1,2}/i);
      const stRaw = stMatch ? stMatch[0] : null;
      let st = null;
      if (stRaw) {
        const neg = /^F/i.test(stRaw);
        const n = Number(stRaw.replace(/^F/i, ''));
        if (Number.isFinite(n)) st = neg ? -Math.abs(n) : n;
      }
      startInfo.push({ boat_number: boat, st, st_raw: stRaw });
    }
  }

  const winningMethods = ['まくり差し','逃げ','差し','まくり','抜き','恵まれ'];
  let winningMethod = null;
  for (const method of winningMethods) {
    if (html.includes(method)) { winningMethod = method; break; }
  }

  const getNumberAfter = (label) => {
    const re = new RegExp(`${label}<\\/span>\\s*<span[^>]*>([^<]+)<\\/span>`);
    const m = html.match(re);
    return m ? toFloat(m[1]) : null;
  };
  const weatherMatch = html.match(/weather1_bodyUnit\s+is-weather[\s\S]{0,350}?weather1_bodyUnitLabelTitle">([^<]+)<\/span>/);
  const windBlock = html.match(/weather1_bodyUnit\s+is-wind[\s\S]{0,500}?weather1_bodyUnitLabelTitle">([^<]+)<\/span>/i);
  const windDirText = windBlock ? stripTags(windBlock[1]) : null;

  const t1 = finishers.find(x => x.finish === 1)?.race_time_seconds ?? null;
  const t2 = finishers.find(x => x.finish === 2)?.race_time_seconds ?? null;
  const t3 = finishers.find(x => x.finish === 3)?.race_time_seconds ?? null;

  return {
    finishers,
    finish_time_count: finishers.filter(x => x.race_time_seconds != null).length,
    race_time_1_raw: finishers.find(x => x.finish === 1)?.race_time_raw ?? null,
    race_time_2_raw: finishers.find(x => x.finish === 2)?.race_time_raw ?? null,
    race_time_3_raw: finishers.find(x => x.finish === 3)?.race_time_raw ?? null,
    race_time_1_seconds: t1,
    race_time_2_seconds: t2,
    race_time_3_seconds: t3,
    margin_1_2_seconds: t1 != null && t2 != null ? Math.round((t2 - t1) * 10) / 10 : null,
    margin_1_3_seconds: t1 != null && t3 != null ? Math.round((t3 - t1) * 10) / 10 : null,
    start_info: startInfo,
    winning_method: winningMethod,
    weather: weatherMatch ? stripTags(weatherMatch[1]) : null,
    wind_dir: windDirText || null,
    wind_speed: getNumberAfter('風速'),
    air_temperature: getNumberAfter('気温'),
    water_temperature: getNumberAfter('水温'),
    wave_height: getNumberAfter('波高'),
  };
}