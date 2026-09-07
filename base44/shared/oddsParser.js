// BOAT WORKS オッズ解析・取得 共通モジュール
// fetchRaceData と fetchRaceOddsOnly で共有する関数群

const RETRY_DELAYS_MS = [1200, 2500];
const ODDS_CACHE_MS = 45 * 1000;

export { RETRY_DELAYS_MS, ODDS_CACHE_MS };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchTextWithRetry(url, validate, label) {
  const u = String(url || '');
  if (/https?:\/\/(www\.)?boatrace\.jp\//i.test(u) && !/\/odds3t\?/i.test(u)) {
    throw new Error(`BOAT RACE公式サイト取得は禁止されています（この経路はオッズ専用）: ${u}`);
  }
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

export function inferScratchedBoats(allOdds) {
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

export function parseOdds3t(html) {
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

// toNum/toFloatはscraper.jsから再輸出（循環参照を避けるためここで軽量定義）
function toNum(str) {
  if (str == null) return 0;
  const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}
function toFloat(str) {
  if (str == null) return 0;
  const n = parseFloat(String(str).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}