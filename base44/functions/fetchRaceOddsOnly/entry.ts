import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { UICHI_COMBOS, syntheticOdds } from '../../shared/uichi.js';
import { toNum, toFloat } from '../../shared/scraper.js';

// BOAT WORKS オッズ専用取得関数
// 公式サイトから3連単オッズだけを取得しOddsSnapshotへ保存する。
// Race/RaceEntryの取得・作成・更新は一切行わない。
// 展示情報も一切書き換えない。
// Final Judge Workerの通常処理から呼ばれる。

const BASE = 'https://boatrace.jp/owpc/pc/race';
const ODDS_CACHE_MS = 45 * 1000;
const RETRY_DELAYS_MS = [1200, 2500];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTextWithRetry(url, validate, label) {
  let lastMessage = `${label}取得失敗`;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' },
      });
      if (!res.ok) {
        lastMessage = `${label}取得失敗 (HTTP ${res.status})`;
      } else {
        const html = await res.text();
        if (html.includes('予期せぬエラーが発生しました')) {
          lastMessage = `${label}取得失敗：公式サイトに該当レースが未公開です`;
        } else {
          const checked = validate(html);
          if (checked?.ok) return { html, value: checked.value, attempt };
          lastMessage = checked?.message || `${label}取得失敗`;
        }
      }
    } catch (e) {
      lastMessage = `${label}取得失敗：${e?.message || '通信エラー'}`;
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw new Error(lastMessage);
}

function inferScratchedBoats(allOdds) {
  const seen = new Set();
  for (const [combo, val] of Object.entries(allOdds || {})) {
    if (!(Number(val) > 1)) continue;
    for (const n of String(combo).split('-').map(Number)) {
      if (n >= 1 && n <= 6) seen.add(n);
    }
  }
  const active = [...seen].sort((a, b) => a - b);
  const scratched = [1, 2, 3, 4, 5, 6].filter(n => !seen.has(n));
  const expected = active.length >= 3 ? active.length * (active.length - 1) * (active.length - 2) : 0;
  const count = Object.values(allOdds || {}).filter(v => Number(v) > 1).length;
  return { active, scratched, expected, count, isConsistent: scratched.length > 0 && expected === count };
}

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
    const re = new RegExp(cellRe.source, 'g');
    while ((cm = re.exec(rowHtml)) !== null) {
      cells.push({ attrs: cm[1], content: cm[2] });
    }
    let group = 0;
    let i = 0;
    while (i + 1 < cells.length && group < 6) {
      if (cells[i].attrs.includes('rowspan')) {
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

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: 'error', message: '認証が必要です' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    const jcd = String(body.jcd || body.venue_code || '').padStart(2, '0');
    const raceNumber = Number(body.race_number);

    if (!raceDate || !jcd || !raceNumber) {
      return Response.json({ status: 'error', message: 'race_date, jcd, race_number が必要です' }, { status: 400 });
    }

    // 既存Raceを取得（オッズ保存先のrace_idが必要なだけ。Race/RaceEntryは書き換えない）
    const existingRace = await base44.asServiceRole.entities.Race.filter({
      race_date: raceDate, venue_code: jcd, race_number: raceNumber,
    }).catch(() => []);
    const currentRace = existingRace[0] || null;
    if (!currentRace) {
      return Response.json({
        status: 'error',
        message: '対象Raceが存在しません。前日出走表取得を先に完了してください。',
        race_date: raceDate, jcd, race_number: raceNumber,
      }, { status: 404 });
    }

    // 45秒以内のキャッシュ再利用
    if (!body.force && currentRace?.odds_fetched_at) {
      const ageMs = Date.now() - new Date(currentRace.odds_fetched_at).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ODDS_CACHE_MS) {
        const snapshots = await base44.asServiceRole.entities.OddsSnapshot.filter(
          { race_id: currentRace.id }, '-captured_at', 1
        ).catch(() => []);
        const cached = snapshots[0];
        const cachedOdds = cached?.all_trifecta_odds || {};
        const cachedScratch = inferScratchedBoats(cachedOdds);
        if (cachedScratch.count >= 120 || cachedScratch.isConsistent) {
          return Response.json({
            status: 'success',
            race_id: currentRace.id,
            odds_count: cachedScratch.count,
            synthetic_odds: cached.synthetic_odds ?? null,
            captured_at: cached.captured_at,
            scratched_boats: cachedScratch.isConsistent ? cachedScratch.scratched : (cached.scratched_boats || []),
            has_scratch: cachedScratch.scratched.length > 0 || cached.has_scratch === true,
            cached: true,
          });
        }
      }
    }

    // オッズ取得
    const hd = raceDate.replace(/-/g, '');
    const oddsUrl = `${BASE}/odds3t?rno=${raceNumber}&jcd=${jcd}&hd=${hd}`;
    const odFetched = await fetchTextWithRetry(oddsUrl, (html) => {
      const value = parseOdds3t(html);
      const scratch = inferScratchedBoats(value);
      const count = scratch.count;
      if (count >= 120) return { ok: true, value };
      if (scratch.isConsistent) return { ok: true, value };
      return { ok: false, message: `オッズ取得失敗：${count}件（120通り未満）` };
    }, 'オッズ');

    const allOdds = odFetched.value;
    const scratchInfo = inferScratchedBoats(allOdds);
    const oddsCount = scratchInfo.count;
    const scratchedBoats = oddsCount < 120 && scratchInfo.isConsistent ? scratchInfo.scratched : [];

    // ういち買い6点抽出
    const uichiVals = UICHI_COMBOS.map((c) => allOdds[c]);
    const allValid = uichiVals.every((v) => v != null && v > 1);
    const synth = allValid ? syntheticOdds(uichiVals) : null;

    const now = new Date().toISOString();

    // OddsSnapshot保存（Race/RaceEntryは一切触らない）
    const oddsRecord = {
      race_id: currentRace.id,
      race_date: raceDate,
      captured_at: now,
      stage: 'final',
      odds_1_2_5: allOdds['1-2-5'] ?? null,
      odds_1_2_6: allOdds['1-2-6'] ?? null,
      odds_1_3_5: allOdds['1-3-5'] ?? null,
      odds_1_3_6: allOdds['1-3-6'] ?? null,
      odds_1_4_5: allOdds['1-4-5'] ?? null,
      odds_1_4_6: allOdds['1-4-6'] ?? null,
      synthetic_odds: synth,
      all_trifecta_odds: allOdds,
      scratched_boats: scratchedBoats,
      has_scratch: scratchedBoats.length > 0,
    };
    await base44.asServiceRole.entities.OddsSnapshot.create(oddsRecord);

    // Raceのodds_fetched_atだけ更新（選手情報・展示情報は一切触らない）
    await base44.asServiceRole.entities.Race.update(currentRace.id, {
      odds_fetched_at: now,
      last_updated: now,
    });

    return Response.json({
      status: 'success',
      race_id: currentRace.id,
      odds_count: oddsCount,
      uichi: {
        '1-2-5': allOdds['1-2-5'],
        '1-2-6': allOdds['1-2-6'],
        '1-3-5': allOdds['1-3-5'],
        '1-3-6': allOdds['1-3-6'],
        '1-4-5': allOdds['1-4-5'],
        '1-4-6': allOdds['1-4-6'],
      },
      synthetic_odds: synth,
      captured_at: now,
      cached: false,
      retry_count: odFetched.attempt || 0,
      scratched_boats: scratchedBoats,
      has_scratch: scratchedBoats.length > 0,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}