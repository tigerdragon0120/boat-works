// BOAT WORKS 公式競走成績Kファイル パーサー (V2)
// Shift-JIS/CP932の競走成績TXTを解析し、検証可能な構造化データへ変換する。
// 番組表Bファイルと異なり、着順・決まり手・払戻金等のレース結果を含む。

import { VENUE_MASTER, computeSHA256, decodeShiftJIS } from './programBParser.js';

export const K_PARSER_VERSION = "K2V1.1.0";

// ─── 文字列正規化 ──────────────────────────────────────
function toHalfWidth(str) {
  return str
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ");
}

function normalizeText(text) {
  let r = toHalfWidth(text);
  r = r.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return r;
}

// ─── 数値パース ─────────────────────────────────────────
function parseIntOrNull(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (s === "" || s === "-" || s === "—") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatOrNull(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (s === "" || s === "-" || s === "—") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// ─── ファイル名日付抽出 ──────────────────────────────────
// K260906.TXT → 2026-09-06
export function extractDateFromKFileName(fileName) {
  const m = fileName.match(/K(\d{2})(\d{2})(\d{2})/i);
  if (!m) return null;
  const year = 2000 + parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// ─── 着順ステータス判定 ──────────────────────────────────
// race_timeフィールドから着順ステータスを判定
function parseFinishStatus(raceTimeRaw, startTimingRaw) {
  const rt = (raceTimeRaw || "").trim();
  const st = (startTimingRaw || "").trim();

  if (/失格/.test(rt)) return "DISQUALIFIED";
  if (/転覆/.test(rt)) return "CAPSIZED";
  if (/落水/.test(rt)) return "FELL";
  if (/不完走/.test(rt)) return "INCOMPLETE";
  if (/欠場/.test(rt) || /欠場/.test(st)) return "ABSENT";
  if (/返還/.test(rt)) return "RETURNED";
  if (/^\d+\.\d+\.\d+$/.test(rt) || /^\d+'?\d/.test(rt)) return "FINISHED";
  if (rt === "" && st === "") return "PENDING";
  return "FINISHED";
}

// ─── 選手結果行解析 ──────────────────────────────────────
// 固定位置で着順・艇番・登録番号・選手名・モーター・ボート・展示・進入・ST・タイムを抽出
function parseRacerResultLine(line, lineNumber) {
  if (!line || line.length < 47) return null;

  // 着順・艇番・登録番号のパターンチェック
  // 数字のほか、S0/S1/S2(失格)、F/L(スタート事故)、K1(欠場)を受け付ける。
  if (!/^\s*(?:\d{1,2}|S\d|F|L|K\d)\s+\d\s+\d{4}/.test(line.substring(0, 15))) return null;

  const finishRaw = line.substring(2, 4).trim();
  const boat_number = parseIntOrNull(line.substring(6, 7));
  const registration_number = line.substring(8, 12).trim();
  const racer_name = line.substring(13, 21).trim().replace(/\s/g, '');
  const motor_number = parseIntOrNull(line.substring(22, 24));
  const boat_number_official = parseIntOrNull(line.substring(27, 29));
  const exhibition_time = parseFloatOrNull(line.substring(30, 35));
  const start_course = parseIntOrNull(line.substring(38, 39));
  const start_timing = line.substring(43, 47).trim();
  const race_time = line.length >= 58 ? line.substring(52, 58).trim() : line.substring(47).trim();

  if (boat_number == null) return null;
  if (!/^\d{4}$/.test(registration_number)) return null;

  // 着順解析: 数字の場合はそのまま、特殊コードは公式状態へ変換する。
  const finish_order = /^\d+$/.test(finishRaw) ? parseIntOrNull(finishRaw) : null;
  let finish_status = parseFinishStatus(race_time, start_timing);
  if (/^K\d$/.test(finishRaw)) {
    finish_status = "ABSENT";
  } else if (/^S\d$/.test(finishRaw) || /^[FL]$/.test(finishRaw)) {
    finish_status = "DISQUALIFIED";
  }
  const is_absent = finish_status === "ABSENT";
  const is_disqualified = finish_status === "DISQUALIFIED";
  // F/L/K系は舟券返還対象として保持する。
  const is_returned = finish_status === "RETURNED" || /^[FL]$/.test(finishRaw) || /^K\d$/.test(finishRaw);

  return {
    finish_order,
    boat_number,
    registration_number,
    racer_name,
    motor_number,
    boat_number_official,
    exhibition_time,
    start_course,
    start_timing,
    race_time,
    finish_status,
    is_absent,
    is_disqualified,
    is_returned,
    source_line: lineNumber,
  };
}

// ─── 払戻行解析 ──────────────────────────────────────────
function parsePayoutLine(line, race_key, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 特払い行: "2連複      特払い   70" → 返還として記録
  const tokuMatch = trimmed.match(/^(単勝|複勝|2連単|2連複|3連単|3連複|拡連複)\s+特払い\s+(\d+)\s*$/);
  if (tokuMatch) {
    const bet_type = tokuMatch[1];
    const amount = parseIntOrNull(tokuMatch[2]);
    return {
      race_key,
      bet_type,
      combination: "特払",
      payout_amount: amount,
      popularity: null,
      is_refund: true,
      source_line: lineNumber,
    };
  }

  // 単勝: "単勝     4          440"
  const tanshoMatch = trimmed.match(/^単勝\s+(\d)\s+(\d+)\s*$/);
  if (tanshoMatch) {
    return {
      race_key,
      bet_type: "単勝",
      combination: tanshoMatch[1],
      payout_amount: parseIntOrNull(tanshoMatch[2]),
      popularity: null,
      is_refund: false,
      source_line: lineNumber,
    };
  }

  // 複勝: "複勝     4          130  1          110"
  const fukushoMatch = trimmed.match(/^複勝\s+(\d)\s+(\d+)(?:\s+(\d)\s+(\d+))?\s*$/);
  if (fukushoMatch) {
    const results = [];
    results.push({
      race_key,
      bet_type: "複勝",
      combination: fukushoMatch[1],
      payout_amount: parseIntOrNull(fukushoMatch[2]),
      popularity: null,
      is_refund: false,
      source_line: lineNumber,
    });
    if (fukushoMatch[3] && fukushoMatch[4]) {
      results.push({
        race_key,
        bet_type: "複勝",
        combination: fukushoMatch[3],
        payout_amount: parseIntOrNull(fukushoMatch[4]),
        popularity: null,
        is_refund: false,
        source_line: lineNumber,
      });
    }
    return results;
  }

  // 2連単/2連複/3連単/3連複: "2連単   4-1        640  人気     3"
  const standardMatch = trimmed.match(/^(2連単|2連複|3連単|3連複)\s+([\d-]+)\s+(\d+)\s+人気\s+(\d+)\s*$/);
  if (standardMatch) {
    return {
      race_key,
      bet_type: standardMatch[1],
      combination: standardMatch[2],
      payout_amount: parseIntOrNull(standardMatch[3]),
      popularity: parseIntOrNull(standardMatch[4]),
      is_refund: false,
      source_line: lineNumber,
    };
  }

  // 拡連複(1行目): "拡連複   1-4        130  人気     1"
  const wideMatch = trimmed.match(/^拡連複\s+([\d-]+)\s+(\d+)\s+人気\s+(\d+)\s*$/);
  if (wideMatch) {
    return {
      race_key,
      bet_type: "拡連複",
      combination: wideMatch[1],
      payout_amount: parseIntOrNull(wideMatch[2]),
      popularity: parseIntOrNull(wideMatch[3]),
      is_refund: false,
      source_line: lineNumber,
    };
  }

  // 拡連複(2行目以降): "         4-5        380  人気     7"
  const wideContMatch = trimmed.match(/^([\d-]+)\s+(\d+)\s+人気\s+(\d+)\s*$/);
  if (wideContMatch) {
    return {
      race_key,
      bet_type: "拡連複",
      combination: wideContMatch[1],
      payout_amount: parseIntOrNull(wideContMatch[2]),
      popularity: parseIntOrNull(wideContMatch[3]),
      is_refund: false,
      source_line: lineNumber,
      is_continuation: true,
    };
  }

  return null;
}

// ─── レースヘッダー解析 ──────────────────────────────────
function parseRaceHeader(line, lineNumber) {
  // "   1R       朝1戦                    H1800m  雨 風  南   2m  波   2cm"
  const m = line.match(/^\s*(\d{1,2})R\s+(.+?)\s+H(\d+)m\s+(.+?)\s+風\s+(.+?)\s+(\d+)m\s+波\s+(\d+)cm/);
  if (!m) return null;

  return {
    race_number: parseIntOrNull(m[1]),
    race_name: m[2].trim().replace(/\s+/g, ''),
    race_distance: parseIntOrNull(m[3]),
    weather: m[4].trim(),
    wind_direction: m[5].trim(),
    wind_speed: parseIntOrNull(m[6]),
    wave_height: parseIntOrNull(m[7]),
    source_line: lineNumber,
  };
}

// ─── コラムヘッダー解析 ──────────────────────────────────
// "着 艇 登番 選手名 モータ ボート 展示 進入 タイミング タイム まくり差し"
// → 決まり手を抽出
function parseColumnHeader(line) {
  // 公式Kは通常「ﾚｰｽﾀｲﾑ まくり」のように半角カナを使用する。
  const match = line.match(/(?:ﾚｰｽﾀｲﾑ|レースタイム|タイム)\s*(.*)$/);
  if (!match) return null;
  const method = match[1].trim();
  return method || null;
}

// ─── メイン解析 ──────────────────────────────────────────
export function parseProgramK(rawText, fileName) {
  const errors = [];
  const warnings = [];
  const unparsed_lines = [];

  const text = normalizeText(rawText);
  const lines = text.split("\n");

  // STARTK確認
  const startIdx = lines.findIndex((l) => l.trim() === "STARTK");
  if (startIdx < 0) {
    errors.push({
      line: 0,
      severity: "FATAL",
      message: "STARTKが見つかりません。競走成績Kファイルではありません。",
      raw: "",
    });
    return { venues: [], races: [], entry_results: [], payouts: [], errors, warnings, unparsed_lines, source_date: null };
  }

  const venues = [];
  const races = [];
  const entry_results = [];
  const payouts = [];

  let i = startIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    const venueMatch = line.match(/^(\d{2})KBGN/);
    if (!venueMatch) {
      // FINALK or END check
      if (line.trim() === "FINALK" || line.trim() === "END") {
        break;
      }
      i++;
      continue;
    }

    const venueCode = venueMatch[1];
    i++;

    // ヘッダー行を収集(最初のレース見出しまで)
    const headerLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^\d{2}KBGN/.test(l)) break;
      if (l.trim() === "FINALK" || l.trim() === "END") break;
      if (/^\d{2}KEND/.test(l)) break;
      // レースヘッダー検出(だしスペース+NR+レース名+H)
      if (/^\s*\d{1,2}R\s+.+H\d+m/.test(l)) break;
      // 払戻金サマリーテーブル検出
      if (/払戻金/.test(l)) break;
      headerLines.push(l);
      i++;
    }

    // ヘッダー解析: 開催日・シリーズ名・何日目
    const headerText = headerLines.join("\n");

    // 日付抽出: "2025/ 8/11" → 2025-08-11
    const dateMatch = headerText.match(/(\d{4})\/\s*(\d{1,2})\/\s*(\d{1,2})/);
    const sourceDate = dateMatch
      ? `${dateMatch[1]}-${pad2(parseInt(dateMatch[2], 10))}-${pad2(parseInt(dateMatch[3], 10))}`
      : null;

    // シリーズ名・何日目抽出
    const dayMatch = headerText.match(/第\s*(\d{1,2})\s*日/);
    const seriesDay = dayMatch ? parseInt(dayMatch[1], 10) : null;

    // 会場名抽出: "唐 津[成績]" → "唐津"
    let venueName = null;
    const venueNameMatch = headerText.match(/^(.+?)\[成績\]/m);
    if (venueNameMatch) {
      venueName = venueNameMatch[1].trim().replace(/\s/g, '');
    }
    if (!venueName) {
      venueName = VENUE_MASTER[venueCode] || `不明(${venueCode})`;
    }

    venues.push({
      venue_code: venueCode,
      venue_name: venueName,
      source_date: sourceDate,
      series_day_number: seriesDay,
    });

    // 払戻金サマリーテーブルをスキップ
    while (i < lines.length) {
      const l = lines[i];
      if (/^\d{2}KBGN/.test(l)) break;
      if (l.trim() === "FINALK" || l.trim() === "END") break;
      if (/^\d{2}KEND/.test(l)) break;
      // レースヘッダーが見つかったら抜ける
      if (/^\s*\d{1,2}R\s+.+H\d+m/.test(l)) break;
      i++;
    }

    // レース解析
    while (i < lines.length) {
      const l = lines[i];
      if (/^\d{2}KBGN/.test(l)) break;
      if (l.trim() === "FINALK" || l.trim() === "END") break;
      if (/^\d{2}KEND/.test(l)) {
        i++;
        break;
      }

      const raceHeader = parseRaceHeader(l, i + 1);
      if (!raceHeader) {
        // 空行や区切り線は無視
        if (l.trim() && !/^[-=]+$/.test(l.trim())) {
          // 未解析行として記録(ただし既知のヘッダー行は除外)
          if (!/競走成績|内容については|★★|ボートレース/.test(l)) {
            unparsed_lines.push({ line: i + 1, content: l.trim().substring(0, 100) });
          }
        }
        i++;
        continue;
      }

      const raceNumber = raceHeader.race_number;
      if (!sourceDate) {
        errors.push({
          line: i + 1,
          severity: "ERROR",
          message: `開催日が取得できません(場${venueCode} ${raceNumber}R)`,
          raw: l,
        });
      }

      const raceKey = sourceDate
        ? `${sourceDate}_${venueCode}_${pad2(raceNumber)}`
        : `${venueCode}_${pad2(raceNumber)}`;

      i++;

      // コラムヘッダー行(決まり手含む)
      let winning_method = null;
      let columnHeaderParsed = false;
      while (i < lines.length) {
        const cl = lines[i];
        if (/^\s*\d{1,2}R\s+.+H\d+m/.test(cl)) break;
        if (/^\d{2}KBGN/.test(cl)) break;
        if (/^\d{2}KEND/.test(cl)) break;
        if (cl.trim() === "FINALK" || cl.trim() === "END") break;

        if (/着.*艇.*登番.*選.*手.*名/.test(cl)) {
          winning_method = parseColumnHeader(cl);
          columnHeaderParsed = true;
          i++;
          break;
        }
        // 区切り線スキップ
        if (/^[-=]+$/.test(cl.trim())) {
          i++;
          continue;
        }
        i++;
      }

      // 区切り線スキップ
      while (i < lines.length && /^[-=]+$/.test(lines[i].trim())) {
        i++;
      }

      // 選手結果行を最大6件取得
      let entryCount = 0;
      while (i < lines.length && entryCount < 6) {
        const rl = lines[i];
        if (/^\s*\d{1,2}R\s+.+H\d+m/.test(rl)) break;
        if (/^\d{2}KBGN/.test(rl)) break;
        if (/^\d{2}KEND/.test(rl)) break;
        if (rl.trim() === "FINALK" || rl.trim() === "END") break;
        // 空行で選手結果終了
        if (rl.trim() === "") break;
        // 払戻行の開始(単勝/複勝/2連単等)で終了
        if (/^\s*(単勝|複勝|2連単|2連複|3連単|3連複|拡連複)/.test(rl)) break;

        const parsed = parseRacerResultLine(rl, i + 1);
        if (parsed) {
          const entryKey = `${raceKey}_${parsed.boat_number}`;
          entry_results.push({
            entry_result_key: entryKey,
            entry_key: entryKey,
            race_key: raceKey,
            boat_number: parsed.boat_number,
            registration_number: parsed.registration_number,
            racer_name: parsed.racer_name,
            finish_order: parsed.finish_order,
            finish_status: parsed.finish_status,
            start_course: parsed.start_course,
            start_timing: parsed.start_timing,
            race_time: parsed.race_time,
            is_absent: parsed.is_absent,
            is_disqualified: parsed.is_disqualified,
            is_returned: parsed.is_returned,
            source_line: parsed.source_line,
          });
          entryCount++;
        } else {
          // 未解析行
          unparsed_lines.push({ line: i + 1, content: rl.trim().substring(0, 100) });
        }
        i++;
      }

      // 払戻行解析
      let lastBetType = null;
      while (i < lines.length) {
        const pl = lines[i];
        if (/^\s*\d{1,2}R\s+.+H\d+m/.test(pl)) break;
        if (/^\d{2}KBGN/.test(pl)) break;
        if (/^\d{2}KEND/.test(pl)) break;
        if (pl.trim() === "FINALK" || pl.trim() === "END") break;
        // 2回連続空行で終了
        if (pl.trim() === "") {
          // 次の行も空かレースヘッダーなら終了
          const nextLine = lines[i + 1] || "";
          if (nextLine.trim() === "" || /^\s*\d{1,2}R\s/.test(nextLine) || /^\d{2}K(END|BGN)/.test(nextLine)) {
            break;
          }
          i++;
          continue;
        }

        const payout = parsePayoutLine(pl, raceKey, i + 1);
        if (payout) {
          if (Array.isArray(payout)) {
            payouts.push(...payout);
          } else {
            payouts.push(payout);
          }
        } else {
          // 未解析行(ただし区切り線は除外)
          if (!/^[-=]+$/.test(pl.trim())) {
            unparsed_lines.push({ line: i + 1, content: pl.trim().substring(0, 100) });
          }
        }
        i++;
      }

      // レース結果登録
      const hasResults = entryCount > 0;
      const result_status = hasResults ? "CONFIRMED" : "PENDING";

      races.push({
        race_key: raceKey,
        source_date: sourceDate,
        venue_code: venueCode,
        venue_name: venueName,
        race_number: raceNumber,
        race_name: raceHeader.race_name,
        race_distance: raceHeader.race_distance,
        winning_method: winning_method,
        weather: raceHeader.weather,
        wind_direction: raceHeader.wind_direction,
        wind_speed: raceHeader.wind_speed,
        wave_height: raceHeader.wave_height,
        result_status: result_status,
        official_confirmed: hasResults,
        source_line: raceHeader.source_line,
      });
    }
  }

  return { venues, races, entry_results, payouts, errors, warnings, unparsed_lines, source_date: venues[0]?.source_date || null };
}

// ─── 検証 ────────────────────────────────────────────────
export function validateKParseResult(parsed, fileName) {
  const { venues, races, entry_results, payouts, errors } = parsed;
  const fatalErrors = [...(errors || [])];
  const warnings = [...(parsed.warnings || [])];

  const fileDate = extractDateFromKFileName(fileName || "");

  // 1. ファイル名日付と本文開催日の一致
  if (fileDate && parsed.source_date && fileDate !== parsed.source_date) {
    fatalErrors.push({
      line: 0,
      severity: "FATAL",
      message: `ファイル名日付(${fileDate})と本文開催日(${parsed.source_date})が不一致`,
      raw: "",
    });
  }

  // 2. 全会場の開催日一致
  const dateSet = new Set(venues.map((v) => v.source_date).filter(Boolean));
  if (dateSet.size > 1) {
    fatalErrors.push({
      line: 0,
      severity: "FATAL",
      message: `会場間で開催日が不一致: ${[...dateSet].join(", ")}`,
      raw: "",
    });
  }

  // 3. venue_code範囲チェック
  for (const v of venues) {
    const code = parseInt(v.venue_code, 10);
    if (isNaN(code) || code < 1 || code > 24) {
      fatalErrors.push({
        line: 0,
        severity: "FATAL",
        message: `場コードが範囲外: ${v.venue_code}`,
        raw: "",
      });
    }
  }

  // 4. 同一会場のrace_number重複チェック
  const raceNumByVenue = {};
  for (const r of races) {
    const key = `${r.venue_code}_${r.race_number}`;
    if (raceNumByVenue[key]) {
      fatalErrors.push({
        line: r.source_line || 0,
        severity: "FATAL",
        message: `同一会場でレース番号重複: ${r.venue_code}場 ${r.race_number}R`,
        raw: "",
      });
    }
    raceNumByVenue[key] = true;
  }

  // 5. race_key重複
  const raceKeySet = new Set();
  for (const r of races) {
    if (raceKeySet.has(r.race_key)) {
      fatalErrors.push({
        line: r.source_line || 0,
        severity: "FATAL",
        message: `race_key重複: ${r.race_key}`,
        raw: "",
      });
    }
    raceKeySet.add(r.race_key);
  }

  // 6. entry_result_key重複
  const entryKeySet = new Set();
  for (const e of entry_results) {
    if (entryKeySet.has(e.entry_result_key)) {
      fatalErrors.push({
        line: e.source_line || 0,
        severity: "FATAL",
        message: `entry_result_key重複: ${e.entry_result_key}`,
        raw: "",
      });
    }
    entryKeySet.add(e.entry_result_key);
  }

  // 7. 着順重複チェック(同一レース内)
  const finishByRace = {};
  for (const e of entry_results) {
    if (!finishByRace[e.race_key]) finishByRace[e.race_key] = [];
    if (e.finish_status === "FINISHED") {
      finishByRace[e.race_key].push(e.finish_order);
    }
  }
  for (const [rk, orders] of Object.entries(finishByRace)) {
    const orderSet = new Set();
    for (const o of orders) {
      if (orderSet.has(o)) {
        fatalErrors.push({
          line: 0,
          severity: "ERROR",
          message: `着順重複: ${rk} 着順${o}`,
          raw: "",
        });
      }
      orderSet.add(o);
    }
  }

  // 8. 孤立Entry(対応するRaceがない)
  const raceKeyMap = new Set(races.map((r) => r.race_key));
  const orphanEntries = entry_results.filter((e) => !raceKeyMap.has(e.race_key));
  if (orphanEntries.length > 0) {
    fatalErrors.push({
      line: 0,
      severity: "FATAL",
      message: `参照不能Entry結果(対応Raceなし): ${orphanEntries.length}件`,
      raw: "",
    });
  }

  // 9. 孤立Payout(対応するRaceがない)
  const orphanPayouts = payouts.filter((p) => !raceKeyMap.has(p.race_key));
  if (orphanPayouts.length > 0) {
    fatalErrors.push({
      line: 0,
      severity: "FATAL",
      message: `参照不能Payout(対応Raceなし): ${orphanPayouts.length}件`,
      raw: "",
    });
  }

  // 10. 未解析行が多い場合は警告
  if (parsed.unparsed_lines && parsed.unparsed_lines.length > 20) {
    warnings.push({
      line: 0,
      severity: "WARN",
      message: `未解析行が多すぎます: ${parsed.unparsed_lines.length}件`,
      raw: "",
    });
  }

  const isImportable = fatalErrors.filter((e) => e.severity === "FATAL" || e.severity === "ERROR").length === 0;

  return {
    fatal_errors: fatalErrors.filter((e) => e.severity === "FATAL" || e.severity === "ERROR"),
    warnings,
    is_importable: isImportable,
    venue_count: venues.length,
    race_count: races.length,
    entry_result_count: entry_results.length,
    payout_count: payouts.length,
    unparsed_line_count: parsed.unparsed_lines?.length || 0,
  };
}

export { computeSHA256, decodeShiftJIS };