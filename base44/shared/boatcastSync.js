// BOAT WORKS: BOATCAST同期共通ロジック
// syncBoatcastDay / syncBoatcastRace / syncBoatcastToday で共有使用

const HP = 'https://race.boatcast.jp/hp_txt';
const TXT = 'https://race.boatcast.jp/txt';

export const VENUE_NAMES = {
  "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
  "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
  "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
  "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
  "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村"
};

export const ALL_VENUE_CODES = Object.keys(VENUE_NAMES);

const TYPES = {
  STR3: ['hp', 'bc_j_str3', 3600000],
  TKZ: ['hp', 'bc_j_tkz', 300000],
  STT: ['hp', 'bc_j_stt', 300000],
  ODDS: ['txt', 'bc_smt_od3', 60000],
  FINAL_ODDS: ['txt', 'bc_kakutei_od3', Infinity],
  RS1: ['txt', 'bc_rs1', Infinity],
  RS2: ['txt', 'bc_rs2', Infinity],
};

const cache = new Map();
const inflight = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function boatcastUrl(type, venueCode, raceDate, raceNumber) {
  const d = TYPES[type];
  if (!d) throw new Error('unknown type ' + type);
  const hd = String(raceDate).replace(/-/g, '');
  const vc = String(venueCode).padStart(2, '0');
  const rn = String(raceNumber).padStart(2, '0');
  return (d[0] === 'hp' ? HP : TXT) + '/' + vc + '/' + d[1] + '_' + hd + '_' + vc + '_' + rn + '.txt';
}

export async function fetchBoatcastText({ type, venueCode, raceDate, raceNumber, force = false }) {
  const url = boatcastUrl(type, venueCode, raceDate, raceNumber);
  const ttl = TYPES[type][2];
  const c = cache.get(url);
  if (!force && c && (ttl === Infinity || Date.now() - c.at < ttl)) return { ok: true, text: c.text, url, cache: 'HIT' };
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    let last = '';
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (res.status === 200) {
          const text = await res.text();
          cache.set(url, { text, at: Date.now() });
          return { ok: true, text, url, status: 200, cache: 'MISS' };
        }
        if (res.status === 404 || res.status === 403) return { ok: false, url, status: res.status };
        last = 'HTTP ' + res.status;
      } catch (e) { last = e.message; }
      await sleep(500 * (i + 1));
    }
    return { ok: false, url, error: last };
  })();
  inflight.set(url, p);
  try { return await p; } finally { inflight.delete(url); }
}

function zenToHalf(s) {
  return String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function n(v) {
  const x = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(x) ? x : null;
}

function s(v) { return String(v ?? '').trim(); }

// Parse STR3 (出走表)
export function parseStr3(text) {
  const ls = text.split(/\r?\n/).filter(x => x.trim() && x.trim() !== 'data=');
  return ls.slice(1, 7).map((l, i) => {
    const p = l.split('\t');
    const bb = s(p[3]).split(':');
    const scratchFlag = s(p[6]);
    return {
      boat_number: i + 1,
      registration_number: s(p[0]),
      racer_name: s(p[1]).replace(/[\s　]/g, ''),
      grade_class: s(p[5]),
      branch: s(bb[0]).replace(/[\s　]/g, ''),
      age: n(p[4]),
      avg_st: n(p[9]),
      national_win_rate: n(p[10]),
      national_2rate: n(p[11]),
      national_3rate: n(p[12]),
      local_win_rate: n(p[13]),
      local_2rate: n(p[14]),
      local_3rate: n(p[15]),
      f_count: n(p[16]),
      motor_number: n(p[17]),
      motor_2rate: n(p[18]),
      motor_3rate: n(p[19]),
      boat_number_id: n(p[21]),
      boat_2rate: n(p[22]),
      boat_3rate: n(p[23]),
      season_record: p.slice(25).filter(Boolean).join('|'),
      is_scratched: scratchFlag !== '' && scratchFlag !== ' ',
      scratch_reason: scratchFlag || null,
    };
  });
}

// Parse TKZ (展示タイム)
export function parseTkz(text) {
  const ls = text.split(/\r?\n/).filter(x => x.trim() && x.trim() !== 'data=');
  const rows = ls.filter(l => !/^\d\t\.\d/.test(l)).slice(0, 6);
  const st = ls.find(l => /^\d\t\.\d/.test(l));
  const stMap = {};
  if (st) {
    const p = st.split('\t');
    for (let i = 0; i < p.length; i += 3) stMap[Number(p[i])] = n(p[i + 1]);
  }
  return rows.map((l, i) => {
    const p = l.split('\t');
    return {
      boat_number: i + 1,
      exhibition_time: n(p[1]),
      weight: n(p[4]),
      tilt: n(String(p[6] ?? '').replace(/\s/g, '')),
      exhibition_st: stMap[i + 1] ?? null,
    };
  });
}

// Parse ODDS (3連単オッズ)
export function parseOdds(text) {
  const ls = text.split(/\r?\n/).filter(x => x.trim() && x.trim() !== 'data=').slice(1, 7);
  const out = {};
  for (let a = 1; a <= 6; a++) {
    const p = ls[a - 1]?.split('\t') || [];
    let k = 1;
    for (let b = 1; b <= 6; b++) {
      if (b === a) continue;
      for (let c = 1; c <= 6; c++) {
        if (c === a || c === b) continue;
        const v = n(p[k++]);
        if (v && v > 0) out[`${a}-${b}-${c}`] = v;
      }
    }
  }
  return out;
}

// Parse RS1 (レース結果)
export function parseRs1(text) {
  const ls = text.split(/\r?\n/).filter(x => x.trim() && x.trim() !== 'data=');
  const finishers = [];
  for (let i = 1; i <= 6 && i < ls.length; i++) {
    const p = ls[i].split('\t');
    const finishOrder = parseInt(zenToHalf(p[0])) || null;
    if (finishOrder == null || !p[1]) break;
    finishers.push({
      finish_order: finishOrder,
      boat_number: parseInt(p[1]) || null,
      racer_name: s(p[2]),
      race_time: s(p[3]),
    });
  }

  const stLines = ls.filter(l => /^\d\t\.\d/.test(l));
  const stMap = {};
  let winningMethod = null;
  for (const l of stLines) {
    const p = l.split('\t');
    const bn = parseInt(p[0]);
    stMap[bn] = n(p[1]);
    if (p[2] && s(p[2])) winningMethod = s(p[2]);
  }

  const courseLine = ls.find(l => /^\d\t\d\t\d\t\d\t\d\t\d$/.test(l.trim()));
  const startCourses = {};
  if (courseLine) {
    const p = courseLine.split('\t');
    for (let i = 0; i < p.length; i++) startCourses[i + 1] = parseInt(p[i]) || null;
  }

  const weatherLine = ls[ls.length - 1];
  let weather = null, windSpeed = null, waveHeight = null, windDir = null;
  if (weatherLine && !/^\d/.test(weatherLine)) {
    const p = weatherLine.split('\t');
    weather = s(p[0]);
    windSpeed = n(String(p[1] ?? '').replace(/[^0-9.]/g, ''));
    waveHeight = n(String(p[2] ?? '').replace(/[^0-9.]/g, ''));
    windDir = s(p[3]);
  }

  const first = finishers.find(f => f.finish_order === 1);
  const second = finishers.find(f => f.finish_order === 2);
  const third = finishers.find(f => f.finish_order === 3);
  const trifecta = first && second && third
    ? `${first.boat_number}-${second.boat_number}-${third.boat_number}`
    : null;

  return { finishers, stMap, startCourses, weather, windSpeed, waveHeight, windDir, trifecta, winningMethod };
}

// Parse RS2 (払戻)
export function parseRs2(text) {
  const ls = text.split(/\r?\n/).filter(x => x.trim() && x.trim() !== 'data=');
  // ls[0] = race_number\t0, ls[1]=2連単, ls[2]=2連複, ls[3]=3連単, ls[4]=3連複, ls[5-7]=拡連複
  const trifectaLine = ls[3];
  if (!trifectaLine) return { trifectaPayout: null };
  const p = trifectaLine.split('\t');
  return { trifectaPayout: n(p[3]), trifectaCombination: `${s(p[0])}-${s(p[1])}-${s(p[2])}` };
}

// 開催場検出: 24場のSTR3(1R)を6場ずつプローブ(レートリミット回避)
export async function discoverVenues(raceDate) {
  const hd = raceDate.replace(/-/g, '');
  const found = [];
  for (let i = 0; i < ALL_VENUE_CODES.length; i += 6) {
    const chunk = ALL_VENUE_CODES.slice(i, i + 6);
    const results = await Promise.all(chunk.map(async (vc) => {
      try {
        const url = `${HP}/${vc}/bc_j_str3_${hd}_${vc}_01.txt`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        return res.status === 200 ? vc : null;
      } catch { return null; }
    }));
    for (const vc of results) if (vc) found.push(vc);
    if (i + 6 < ALL_VENUE_CODES.length) await sleep(300);
  }
  return found;
}

// デフォルト締切時刻 (R1=10:00 JST, 30分間隔)
export function defaultDeadline(raceDate, raceNumber) {
  const totalMinutes = 10 * 60 + (raceNumber - 1) * 30;
  const hour = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  return new Date(`${raceDate}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+09:00`).toISOString();
}