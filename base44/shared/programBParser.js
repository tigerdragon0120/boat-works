// BOAT WORKS 公式番組表Bファイル パーサー (V2)
// Shift-JIS/CP932の番組表TXTを解析し、検証可能な構造化データへ変換する。
// 予想ロジック・展示・オッズ・既存Race連携は一切含まない（第1段階）。

export const PARSER_VERSION = "B2V1.0.0";

export const VENUE_MASTER = {
  "01": "桐生",
  "02": "戸田",
  "03": "江戸川",
  "04": "平和島",
  "05": "多摩川",
  "06": "浜名湖",
  "07": "蒲郡",
  "08": "常滑",
  "09": "津",
  "10": "三国",
  "11": "びわこ",
  "12": "住之江",
  "13": "尼崎",
  "14": "鳴門",
  "15": "丸亀",
  "16": "児島",
  "17": "宮島",
  "18": "徳山",
  "19": "下関",
  "20": "若松",
  "21": "芦屋",
  "22": "福岡",
  "23": "唐津",
  "24": "大村",
};

// ─── 文字列正規化 ──────────────────────────────────────
// 全角ASCII(数字・英字・記号)を半角へ変換。全角スペースも半角へ。
// 日本語文字(漢字・ひらがな・カタカナ)は破壊しない。
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
  if (str == null || str === "-" || str === "") return null;
  const n = parseInt(str, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatOrNull(str) {
  if (str == null || str === "-" || str === "") return null;
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// ─── SHA-256 ────────────────────────────────────────────
export async function computeSHA256(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── ファイル名日付抽出 ──────────────────────────────────
// B260906.TXT → 2026-09-06
export function extractDateFromFileName(fileName) {
  const m = fileName.match(/B(\d{2})(\d{2})(\d{2})/i);
  if (!m) return null;
  const year = 2000 + parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// ─── 選手行 stats解析 ────────────────────────────────────
// 入力例: "5.40 34.13 5.33 38.10 24 57.14158 42.86 56           5"
// 3桁ボート番号時はモーター2連率とボート番号の間の空白が消える。
function parseStats(statsStr) {
  const result = {
    national_win_rate: null,
    national_top2_rate: null,
    local_win_rate: null,
    local_top2_rate: null,
    motor_number: null,
    motor_top2_rate: null,
    boat_number_official: null,
    boat_top2_rate: null,
    series_results_raw: null,
    early_race_number: null,
  };
  if (!statsStr || !statsStr.trim()) return result;

  // 4勝率 + モーター番号 + モーター2連率 + ボート番号 + ボート2連率 + 残り
  // 3桁番号時は直前の\sが0になるため\s*で許容する
  const m = statsStr.match(
    /^(\d+\.\d{1,2})\s+(\d+\.\d{1,2})\s+(\d+\.\d{1,2})\s+(\d+\.\d{1,2})\s*(\d{1,3})\s+(\d+\.\d{1,2})\s*(\d{1,3})\s+(\d+\.\d{1,2})\s+(.+)$/
  );
  if (m) {
    result.national_win_rate = parseFloatOrNull(m[1]);
    result.national_top2_rate = parseFloatOrNull(m[2]);
    result.local_win_rate = parseFloatOrNull(m[3]);
    result.local_top2_rate = parseFloatOrNull(m[4]);
    result.motor_number = parseIntOrNull(m[5]);
    result.motor_top2_rate = parseFloatOrNull(m[6]);
    result.boat_number_official = parseIntOrNull(m[7]);
    result.boat_top2_rate = parseFloatOrNull(m[8]);

    const rest = (m[9] || "").trim();
    if (rest) {
      const tokens = rest.split(/\s+/);
      if (tokens.length >= 2) {
        result.early_race_number = parseIntOrNull(tokens[tokens.length - 1]);
        result.series_results_raw = tokens.slice(0, -1).join("");
      } else if (tokens.length === 1) {
        if (/^\d+$/.test(tokens[0])) {
          result.early_race_number = parseIntOrNull(tokens[0]);
        } else {
          result.series_results_raw = tokens[0];
        }
      }
    }
    return result;
  }

  // フォールバック: 勝率だけ抽出を試みる
  const rates = statsStr.match(/\d+\.\d{1,2}/g);
  if (rates) {
    if (rates[0]) result.national_win_rate = parseFloatOrNull(rates[0]);
    if (rates[1]) result.national_top2_rate = parseFloatOrNull(rates[1]);
    if (rates[2]) result.local_win_rate = parseFloatOrNull(rates[2]);
    if (rates[3]) result.local_top2_rate = parseFloatOrNull(rates[3]);
    if (rates[4]) result.motor_top2_rate = parseFloatOrNull(rates[4]);
    if (rates[5]) result.boat_top2_rate = parseFloatOrNull(rates[5]);
  }
  return result;
}

// ─── 選手行解析 ──────────────────────────────────────────
// 正規表現で艇番・登録番号・氏名・年齢・支部・体重・級別を抽出。
// 空白splitは使わず、構造パターンで認識する。
function parseRacerLine(line, lineNumber) {
  // 艇番(1-6) + 空白? + 登録番号(4桁) + 氏名(非数字) + 年齢(2桁) + 支部(非数字) + 体重(2-3桁) + 級別(A1/A2/B1/B2) + stats
  const m = line.match(
    /^([1-6])\s?(\d{4})(.+?)(\d{2})(\D+?)(\d{2,3})(A1|A2|B1|B2)\s*(.*)$/
  );
  if (!m) return null;

  const boat_number = parseInt(m[1], 10);
  const registration_number = m[2];
  const racer_name = m[3].trim();
  const age = parseIntOrNull(m[4]);
  const branch = m[5].trim();
  const weight = parseIntOrNull(m[6]);
  const cls = m[7];
  const stats = parseStats(m[8]);

  return {
    boat_number,
    registration_number,
    racer_name,
    age,
    branch,
    weight,
    class: cls,
    ...stats,
    source_line: lineNumber,
  };
}

// ─── メイン解析 ──────────────────────────────────────────
// 番組表Bファイル全文を解析し、会場・レース・選手行の構造化データを返す。
// DB書き込みは行わない。
export function parseProgramB(rawText, fileName) {
  const errors = [];
  const warnings = [];

  const text = normalizeText(rawText);
  const lines = text.split("\n");

  // STARTB確認
  const startIdx = lines.findIndex((l) => l.trim() === "STARTB");
  if (startIdx < 0) {
    errors.push({
      line: 0,
      severity: "FATAL",
      message: "STARTBが見つかりません。番組表Bファイルではありません。",
      raw: "",
    });
    return { venues: [], races: [], entries: [], errors, warnings, source_date: null };
  }

  const venues = [];
  const races = [];
  const entries = [];

  let i = startIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    const venueMatch = line.match(/^(\d{2})BBGN/);
    if (!venueMatch) {
      i++;
      continue;
    }

    const venueCode = venueMatch[1];
    i++;

    // ヘッダー行を収集(最初のレース見出しまで)
    const headerLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^\d{2}BBGN/.test(l)) break;
      if (l.trim() === "END") break;
      if (/^\s*\d{1,2}R\s+.+H\d+m/.test(l)) break;
      headerLines.push(l);
      i++;
    }

    // ヘッダー解析: 開催日・シリーズ名・何日目
    const headerText = headerLines.join("\n");
    const dateMatch = headerText.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
    const sourceDate = dateMatch
      ? `${dateMatch[1]}-${pad2(parseInt(dateMatch[2], 10))}-${pad2(parseInt(dateMatch[3], 10))}`
      : null;
    const dayMatch = headerText.match(/第\s*(\d{1,2})\s*日/);
    const seriesDay = dayMatch ? parseInt(dayMatch[1], 10) : null;

    // シリーズ名抽出(会場名行・日付行・注意書き以外の行)
    let seriesTitle = null;
    for (const hl of headerLines) {
      const t = hl.trim();
      if (!t) continue;
      if (/^\d{4}年/.test(t)) continue;
      if (/ボートレース/.test(t) && /\d{1,2}月/.test(t)) continue;
      if (/番組表/.test(t)) continue;
      if (/内容については主催者発行/.test(t)) continue;
      if (/^第\s*\d{1,2}\s*日/.test(t)) continue;
      if (/^[＊*]/.test(t)) continue;
      seriesTitle = t;
      break;
    }

    const venueName = VENUE_MASTER[venueCode] || `不明(${venueCode})`;
    venues.push({
      venue_code: venueCode,
      venue_name: venueName,
      source_date: sourceDate,
      series_title: seriesTitle,
      series_day_number: seriesDay,
    });

    // レース解析
    while (i < lines.length) {
      const l = lines[i];
      if (/^\d{2}BBGN/.test(l)) break;
      if (l.trim() === "END") break;
      if (/^\d{2}BEND/.test(l)) {
        i++;
        break;
      }

      const raceMatch = l.match(
        /^\s*(\d{1,2})R\s+(.+?)\s+H(\d+)m\s+電話投票締切予定\s*(\d{1,2}):(\d{2})/
      );
      if (!raceMatch) {
        i++;
        continue;
      }

      const raceNumber = parseInt(raceMatch[1], 10);
      const raceName = raceMatch[2].trim();
      const distance = parseIntOrNull(raceMatch[3]);
      const deadlineHour = parseInt(raceMatch[4], 10);
      const deadlineMinute = parseInt(raceMatch[5], 10);

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
      const deadlineTime = sourceDate
        ? `${sourceDate}T${pad2(deadlineHour)}:${pad2(deadlineMinute)}:00+09:00`
        : null;

      races.push({
        race_key: raceKey,
        race_date: sourceDate,
        venue_code: venueCode,
        venue_name: venueName,
        race_number: raceNumber,
        race_name: raceName,
        race_distance: distance,
        deadline_time: deadlineTime,
        series_title: seriesTitle,
        series_day_number: seriesDay,
        source_line: i + 1,
      });

      i++;

      // 選手行を最大6件まで取得
      let entryCount = 0;
      while (i < lines.length && entryCount < 6) {
        const rl = lines[i];
        if (/^\d{2}BBGN/.test(rl)) break;
        if (/^\s*\d{1,2}R\s+.+H\d+m/.test(rl)) break;
        if (rl.trim() === "END") break;
        if (/^\d{2}BEND/.test(rl)) break;

        const parsed = parseRacerLine(rl, i + 1);
        if (parsed) {
          const entryKey = `${raceKey}_${parsed.boat_number}`;
          entries.push({
            entry_key: entryKey,
            race_key: raceKey,
            race_date: sourceDate,
            venue_code: venueCode,
            race_number: raceNumber,
            ...parsed,
          });
          entryCount++;
        }
        i++;
      }

      if (entryCount < 6) {
        errors.push({
          line: i + 1,
          severity: "ERROR",
          message: `${venueCode}場 ${raceNumber}R: 選手行が${entryCount}件(6件必要)`,
          raw: "",
        });
      }
    }
  }

  const sourceDate = venues.length > 0 ? venues[0].source_date : null;

  return { venues, races, entries, errors, warnings, source_date: sourceDate };
}

// ─── 検証 ────────────────────────────────────────────────
// 解析結果に対する完全検証。1つでも重大エラーがあれば取込不可。
export function validateParseResult(parsed, fileName) {
  const { venues, races, entries, errors } = parsed;
  const fatalErrors = [...(errors || [])];
  const warnings = [...(parsed.warnings || [])];

  const fileDate = extractDateFromFileName(fileName || "");

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

  // 5. 各会場に1R～12Rが存在
  for (const v of venues) {
    const venueRaces = races.filter((r) => r.venue_code === v.venue_code);
    const nums = new Set(venueRaces.map((r) => r.race_number));
    for (let n = 1; n <= 12; n++) {
      if (!nums.has(n)) {
        fatalErrors.push({
          line: 0,
          severity: "FATAL",
          message: `${v.venue_code}場 ${n}Rが存在しません`,
          raw: "",
        });
      }
    }
  }

  // 6. 各レースに艇番1～6が1件ずつ
  const entriesByRace = {};
  for (const e of entries) {
    if (!entriesByRace[e.race_key]) entriesByRace[e.race_key] = [];
    entriesByRace[e.race_key].push(e);
  }
  for (const r of races) {
    const raceEntries = entriesByRace[r.race_key] || [];
    const boats = new Set(raceEntries.map((e) => e.boat_number));
    for (let b = 1; b <= 6; b++) {
      if (!boats.has(b)) {
        fatalErrors.push({
          line: r.source_line || 0,
          severity: "FATAL",
          message: `${r.venue_code}場 ${r.race_number}R 艇番${b}が存在しません`,
          raw: "",
        });
      }
    }
    if (raceEntries.length > 6) {
      fatalErrors.push({
        line: r.source_line || 0,
        severity: "FATAL",
        message: `${r.venue_code}場 ${r.race_number}R 艇番が6件超過(${raceEntries.length}件)`,
        raw: "",
      });
    }
  }

  // 7. registration_number存在チェック
  for (const e of entries) {
    if (!e.registration_number || !/^\d{4}$/.test(e.registration_number)) {
      fatalErrors.push({
        line: e.source_line || 0,
        severity: "FATAL",
        message: `登録番号不正または欠落: ${e.registration_number || "(空)"} (${e.race_key} 艇${e.boat_number})`,
        raw: "",
      });
    }
  }

  // 8. race_key重複
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

  // 9. entry_key重複
  const entryKeySet = new Set();
  for (const e of entries) {
    if (entryKeySet.has(e.entry_key)) {
      fatalErrors.push({
        line: e.source_line || 0,
        severity: "FATAL",
        message: `entry_key重複: ${e.entry_key}`,
        raw: "",
      });
    }
    entryKeySet.add(e.entry_key);
  }

  // 10. race_count = venue_count × 12
  if (venues.length > 0 && races.length !== venues.length * 12) {
    fatalErrors.push({
      line: 0,
      severity: "FATAL",
      message: `レース数不一致: ${races.length} != 会場数${venues.length}×12(${venues.length * 12})`,
      raw: "",
    });
  }

  // 11. entry_count = race_count × 6
  if (races.length > 0 && entries.length !== races.length * 6) {
    fatalErrors.push({
      line: 0,
      severity: "FATAL",
      message: `選手行数不一致: ${entries.length} != レース数${races.length}×6(${races.length * 6})`,
      raw: "",
    });
  }

  // 12-14. 欠落チェック
  const missingVenue = races.filter((r) => !r.venue_code).length;
  const missingRaceNum = races.filter((r) => !r.race_number).length;
  const missingBoat = entries.filter((e) => !e.boat_number).length;
  if (missingVenue > 0) {
    fatalErrors.push({ line: 0, severity: "FATAL", message: `場コード欠落: ${missingVenue}件`, raw: "" });
  }
  if (missingRaceNum > 0) {
    fatalErrors.push({ line: 0, severity: "FATAL", message: `レース番号欠落: ${missingRaceNum}件`, raw: "" });
  }
  if (missingBoat > 0) {
    fatalErrors.push({ line: 0, severity: "FATAL", message: `艇番欠落: ${missingBoat}件`, raw: "" });
  }

  // 孤立Entry(対応するRaceがない)
  const raceKeyMap = new Set(races.map((r) => r.race_key));
  const orphanEntries = entries.filter((e) => !raceKeyMap.has(e.race_key));
  if (orphanEntries.length > 0) {
    fatalErrors.push({
      line: 0,
      severity: "FATAL",
      message: `参照不能Entry(対応Raceなし): ${orphanEntries.length}件`,
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
    entry_count: entries.length,
    missing_venue_code: missingVenue,
    missing_race_number: missingRaceNum,
    missing_boat_number: missingBoat,
    duplicate_race_key: races.length - raceKeySet.size,
    duplicate_entry_key: entries.length - entryKeySet.size,
    orphan_entries: orphanEntries.length,
  };
}

// ─── デコード ────────────────────────────────────────────
// ArrayBufferをShift-JISとしてデコードし、正規化済みテキストを返す。
export function decodeShiftJIS(arrayBuffer) {
  const decoder = new TextDecoder("shift_jis");
  return decoder.decode(arrayBuffer);
}