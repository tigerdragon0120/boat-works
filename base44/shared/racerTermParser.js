// BOAT WORKS 公式選手期別成績パーサー (V2)
// 公式サイト「モーターボートファン手帳」レイアウトの固定長Shift-JISファイルを
// バイトレベルで解析し、構造化データへ変換する。
// 予想ロジック・B/K取込・分析機能には一切接続しない（第2段階）。

export const PARSER_VERSION = "RT2V1.0.0";

// ─── 固定長フィールド定義（バイト位置） ────────────────────
// 公式レイアウト: https://www.boatrace.jp/owpc/pc/extra/data/layout.html
// 1行 = 416 bytes (2014年後期以降) / 410 bytes (2014年前期以前)

// Section1: 基本情報 (0-81, 82 bytes)
const F_BASIC = {
  registration_number: [0, 4],     // 登番 4
  racer_name: [4, 20],            // 名前漢字 16
  racer_name_kana: [20, 35],      // 名前カナ 15
  branch: [35, 39],                // 支部 4
  racer_class: [39, 41],           // 級 2
  era: [41, 42],                   // 年号 1
  birthday: [42, 48],              // 生年月日 6
  gender: [48, 49],                // 性別 1
  age: [49, 51],                   // 年齢 2
  height: [51, 54],                // 身長 3
  weight: [54, 56],                // 体重 2
  blood_type: [56, 58],            // 血液型 2
  win_rate: [58, 62],              // 勝率 4 (÷100)
  second_place_rate: [62, 66],     // 複勝率 4 (÷10)
  first_place_count: [66, 69],    // 1着回数 3
  second_place_count: [69, 72],    // 2着回数 3
  race_count: [72, 75],            // 出走回数 3
  championship_entries: [75, 77],  // 優出回数 2
  championship_wins: [77, 79],     // 優勝回数 2
  average_start_timing: [79, 82],  // 平均ST 3 (÷100)
};

// Section3: 級別履歴・期情報 (160-197, 38 bytes)
const F_TERM = {
  previous_class: [160, 162],      // 前期級 2
  prev_prev_class: [162, 164],     // 前々期級 2
  prev_prev_prev_class: [164, 166],// 前々々期級 2
  prev_ability_index: [166, 170],  // 前期能力指数 4 (÷100)
  ability_index: [170, 174],        // 今期能力指数 4 (÷100)
  year: [174, 178],                 // 年 4
  term: [178, 179],                 // 期 1 (1:前期, 2:後期)
  period_start: [179, 187],         // 算出期間自 8 (YYYYMMDD)
  period_end: [187, 195],           // 算出期間至 8
  training_term: [195, 198],        // 養成期 3
};

// Section5: コースなし + 出身地 (402-415, 14 bytes)
const F_BIRTHPLACE = [410, 416];    // 出身地 6 (post-2014後期 only)
const NO_COURSE_BASE = 402;         // コースなしL0(2)+L1(2)+K0(2)+K1(2)

// Section4: コース別詳細 (198-401, 6×34=204 bytes)
const COURSE_DETAIL_BASE = 198;
const COURSE_DETAIL_SIZE = 34;

// ─── 文字列正規化 ──────────────────────────────────────
function cleanStr(s) {
  if (s == null) return null;
  const r = s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
  return r || null;
}

function parseNumRaw(str) {
  if (str == null) return null;
  const cleaned = str.replace(/[\s\u3000]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "－" || cleaned === "―") return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function parseDecimal(str, divisor) {
  const n = parseNumRaw(str);
  return n != null ? n / divisor : null;
}

// ─── SHA-256 ────────────────────────────────────────────
export async function computeSHA256(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── バイトレベル行分割 ──────────────────────────────────
// Shift-JISの2バイト文字の第2バイトに0x0A/0x0Dは含まれないため安全に分割可能
function splitLinesByteLevel(uint8Array) {
  const lines = [];
  let lineStart = 0;
  for (let i = 0; i < uint8Array.length; i++) {
    if (uint8Array[i] === 0x0a) {
      let lineEnd = i;
      if (lineEnd > lineStart && uint8Array[lineEnd - 1] === 0x0d) lineEnd--;
      lines.push({ start: lineStart, end: lineEnd, length: lineEnd - lineStart });
      lineStart = i + 1;
    }
  }
  if (lineStart < uint8Array.length) {
    let lineEnd = uint8Array.length;
    if (lineEnd > lineStart && uint8Array[lineEnd - 1] === 0x0d) lineEnd--;
    lines.push({ start: lineStart, end: lineEnd, length: lineEnd - lineStart });
  }
  return lines;
}

// ─── フィールド抽出（バイトスライス→Shift-JISデコード） ────
function decodeField(decoder, uint8Array, absStart, absEnd) {
  if (absEnd <= absStart || absStart >= uint8Array.length) return "";
  const actualEnd = Math.min(absEnd, uint8Array.length);
  return decoder.decode(uint8Array.subarray(absStart, actualEnd));
}

// ─── 1行解析 ─────────────────────────────────────────────
function parseRacerLine(decoder, uint8Array, lineInfo, lineNum) {
  const { start, length } = lineInfo;

  const getBasic = (name) => {
    const [off, end] = F_BASIC[name];
    return decodeField(decoder, uint8Array, start + off, start + end);
  };
  const getTerm = (name) => {
    const [off, end] = F_TERM[name];
    return decodeField(decoder, uint8Array, start + off, start + end);
  };

  // 基本情報
  const registration_number = cleanStr(getBasic("registration_number"));
  const racer_name = cleanStr(getBasic("racer_name"));
  const racer_name_kana = cleanStr(getBasic("racer_name_kana"));
  const branch = cleanStr(getBasic("branch"));
  const racer_class = cleanStr(getBasic("racer_class"));
  const gender = cleanStr(getBasic("gender"));
  const age = parseNumRaw(getBasic("age"));
  const weight = parseNumRaw(getBasic("weight"));
  const win_rate = parseDecimal(getBasic("win_rate"), 100);
  const second_place_rate = parseDecimal(getBasic("second_place_rate"), 10);
  const first_place_count = parseNumRaw(getBasic("first_place_count"));
  const second_place_count = parseNumRaw(getBasic("second_place_count"));
  const race_count = parseNumRaw(getBasic("race_count"));
  const championship_entries = parseNumRaw(getBasic("championship_entries"));
  const championship_wins = parseNumRaw(getBasic("championship_wins"));
  const average_start_timing = parseDecimal(getBasic("average_start_timing"), 100);

  // 期情報
  const previous_class = cleanStr(getTerm("previous_class"));
  const ability_index = parseDecimal(getTerm("ability_index"), 100);
  const year = parseNumRaw(getTerm("year"));
  const term = cleanStr(getTerm("term"));
  const period_start_raw = getTerm("period_start");
  const period_end_raw = getTerm("period_end");

  // 日付パース
  let term_start_date = null;
  let term_end_date = null;
  const psTrim = (period_start_raw || "").trim();
  if (/^\d{8}$/.test(psTrim)) {
    term_start_date = `${psTrim.substring(0, 4)}-${psTrim.substring(4, 6)}-${psTrim.substring(6, 8)}`;
  }
  const peTrim = (period_end_raw || "").trim();
  if (/^\d{8}$/.test(peTrim)) {
    term_end_date = `${peTrim.substring(0, 4)}-${peTrim.substring(4, 6)}-${peTrim.substring(6, 8)}`;
  }

  // 期コード
  let term_code = null;
  let term_label = null;
  if (year != null && term) {
    term_code = `${year}_${term}`;
    term_label = `${year}年${term === "1" ? "前期" : "後期"}`;
  }

  // 出身地（post-2014後期 only）
  let birthplace = null;
  if (length >= 416) {
    birthplace = cleanStr(decodeField(decoder, uint8Array, start + F_BIRTHPLACE[0], start + F_BIRTHPLACE[1]));
  }

  // コース別詳細集計（Section4 + Section5）
  let third_place_count = null;
  let start_accident_count = null;
  let late_count = null;

  if (length >= COURSE_DETAIL_BASE + 6 * COURSE_DETAIL_SIZE) {
    let total3rd = 0;
    let totalF = 0;
    let totalL = 0;
    for (let c = 0; c < 6; c++) {
      const base = start + COURSE_DETAIL_BASE + c * COURSE_DETAIL_SIZE;
      // 3着: base+6, 3 bytes
      const third = parseNumRaw(decodeField(decoder, uint8Array, base + 6, base + 9));
      if (third != null) total3rd += third;
      // F: base+18, 2 bytes
      const f = parseNumRaw(decodeField(decoder, uint8Array, base + 18, base + 20));
      if (f != null) totalF += f;
      // L0: base+20, 2 bytes
      const l0 = parseNumRaw(decodeField(decoder, uint8Array, base + 20, base + 22));
      if (l0 != null) totalL += l0;
      // L1: base+22, 2 bytes
      const l1 = parseNumRaw(decodeField(decoder, uint8Array, base + 22, base + 24));
      if (l1 != null) totalL += l1;
    }
    // Section5: コースなしL0, L1
    if (length >= NO_COURSE_BASE + 4) {
      const ncL0 = parseNumRaw(decodeField(decoder, uint8Array, start + NO_COURSE_BASE, start + NO_COURSE_BASE + 2));
      if (ncL0 != null) totalL += ncL0;
      const ncL1 = parseNumRaw(decodeField(decoder, uint8Array, start + NO_COURSE_BASE + 2, start + NO_COURSE_BASE + 4));
      if (ncL1 != null) totalL += ncL1;
    }
    third_place_count = total3rd;
    start_accident_count = totalF;
    late_count = totalL;
  }

  // racer_term_key
  const racer_term_key = (term_code && registration_number) ? `${term_code}_${registration_number}` : null;

  // 元の行
  const raw_line = decoder.decode(uint8Array.subarray(start, lineInfo.end));

  return {
    racer_term_key,
    term_code,
    term_label,
    term_start_date,
    term_end_date,
    registration_number,
    racer_name,
    racer_name_kana,
    branch,
    birthplace,
    gender,
    age,
    weight,
    racer_class,
    previous_class,
    win_rate,
    second_place_rate,
    third_place_rate: null,
    top2_rate: second_place_rate,
    top3_rate: null,
    average_start_timing,
    race_count,
    first_place_count,
    second_place_count,
    third_place_count,
    start_accident_count,
    late_count,
    accident_rate: null,
    ability_index,
    championship_entries,
    championship_wins,
    raw_line,
    lineNum,
  };
}

// ─── ファイル全体解析 ───────────────────────────────────
export function parseRacerTermFile(arrayBuffer, fileName) {
  const uint8Array = new Uint8Array(arrayBuffer);
  const decoder = new TextDecoder("shift_jis");
  const lineInfos = splitLinesByteLevel(uint8Array);

  const racers = [];
  const errors = [];
  const warnings = [];
  let termCode = null;
  let termLabel = null;
  let termStartDate = null;
  let termEndDate = null;

  let lineNum = 0;
  for (const lineInfo of lineInfos) {
    lineNum++;
    if (lineInfo.length === 0) continue;

    // 基本セクション未満の短い行はスキップ
    if (lineInfo.length < 82) {
      if (lineInfo.length > 2) {
        warnings.push({
          line: lineNum,
          severity: "WARNING",
          message: `行が短すぎます (${lineInfo.length} bytes)`,
          raw: decoder.decode(uint8Array.subarray(lineInfo.start, lineInfo.end)).substring(0, 100),
        });
      }
      continue;
    }

    const parsed = parseRacerLine(decoder, uint8Array, lineInfo, lineNum);

    // 最初の有効行から期コードを取得
    if (!termCode && parsed.term_code) {
      termCode = parsed.term_code;
      termLabel = parsed.term_label;
      termStartDate = parsed.term_start_date;
      termEndDate = parsed.term_end_date;
    }

    // 期コード不一致チェック
    if (termCode && parsed.term_code && parsed.term_code !== termCode) {
      errors.push({
        line: lineNum,
        severity: "ERROR",
        message: `期コード不一致: 期待=${termCode}, 実際=${parsed.term_code}`,
        raw: parsed.raw_line.substring(0, 100),
      });
    }

    // 登録番号欠落
    if (!parsed.registration_number) {
      errors.push({
        line: lineNum,
        severity: "ERROR",
        message: "登録番号が取得できません",
        raw: parsed.raw_line.substring(0, 100),
      });
    }

    // racer_term_key未生成
    if (!parsed.racer_term_key) {
      errors.push({
        line: lineNum,
        severity: "ERROR",
        message: "racer_term_keyが生成できません",
        raw: parsed.raw_line.substring(0, 100),
      });
    }

    if (parsed.racer_term_key) {
      racers.push(parsed);
    }
  }

  // 文字化け検出
  const fullText = decoder.decode(arrayBuffer);
  const replacementCount = (fullText.match(/\uFFFD/g) || []).length;
  const hasMojibake = replacementCount > racers.length;
  if (hasMojibake) {
    errors.push({
      line: 0,
      severity: "ERROR",
      message: `文字化け検出: ${replacementCount}個の置換文字(U+FFFD)`,
      raw: "",
    });
  }

  return {
    term_code: termCode,
    term_label: termLabel,
    term_start_date: termStartDate,
    term_end_date: termEndDate,
    racers,
    errors,
    warnings,
    has_mojibake: hasMojibake,
    encoding: "shift_jis",
    line_count: lineInfos.length,
    valid_line_count: racers.length,
  };
}

// ─── 検証 ───────────────────────────────────────────────
export function validateRacerTermResult(parsed, fileName) {
  const errors = [...parsed.errors];
  const warnings = [...parsed.warnings];

  // 期コード未特定
  if (!parsed.term_code) {
    errors.push({ line: 0, severity: "ERROR", message: "期コードが特定できません", raw: "" });
  }

  // 選手数0件
  if (parsed.racers.length === 0) {
    errors.push({ line: 0, severity: "ERROR", message: "選手数が0件です", raw: "" });
  }

  // 登録番号重複チェック
  const regNumSet = new Set();
  const regNumDuplicates = [];
  for (const r of parsed.racers) {
    if (regNumSet.has(r.registration_number)) {
      regNumDuplicates.push(r.registration_number);
    } else {
      regNumSet.add(r.registration_number);
    }
  }
  if (regNumDuplicates.length > 0) {
    errors.push({
      line: 0,
      severity: "ERROR",
      message: `同一期内登録番号重複: ${regNumDuplicates.length}件 (${regNumDuplicates.slice(0, 5).join(", ")})`,
      raw: "",
    });
  }

  // racer_term_key未生成件数
  const missingKeys = parsed.racers.filter((r) => !r.racer_term_key);
  if (missingKeys.length > 0) {
    errors.push({
      line: 0,
      severity: "ERROR",
      message: `racer_term_key未生成: ${missingKeys.length}件`,
      raw: "",
    });
  }

  // 選手数の警告（即エラーにしない）
  if (parsed.racers.length > 0 && parsed.racers.length < 100) {
    warnings.push({
      line: 0,
      severity: "WARNING",
      message: `選手数が少なめです (${parsed.racers.length}件)`,
      raw: "",
    });
  }
  if (parsed.racers.length > 2000) {
    warnings.push({
      line: 0,
      severity: "WARNING",
      message: `選手数が多めです (${parsed.racers.length}件)`,
      raw: "",
    });
  }

  const errorCount = errors.filter((e) => e.severity === "ERROR").length;
  const isImportable = errorCount === 0 && parsed.racers.length > 0 && !!parsed.term_code;

  return {
    errors,
    warnings,
    is_importable: isImportable,
    term_code: parsed.term_code,
    term_label: parsed.term_label,
    term_start_date: parsed.term_start_date,
    term_end_date: parsed.term_end_date,
    racer_count: parsed.racers.length,
    error_count: errorCount,
    warning_count: warnings.length,
    duplicate_reg_num_count: regNumDuplicates.length,
    has_mojibake: parsed.has_mojibake,
    encoding: parsed.encoding,
  };
}