// BOAT WORKS 集計ロジック（初期構築・日次差分更新で共有）
// RaceResult原本を読み込み、5つの集計Entity(RacerStats/RacerVenueStats/RacerLaneStats/RacerWeatherStats/VenueRaceStats)を構築・更新する。
//
// 重要: RaceResultは削除しない。集計Entityは RaceResult から導出されるキャッシュ。

export const STATS_VERSION = 2;

export function windSpeedGroup(ws) {
  if (ws == null) return "unknown";
  if (ws <= 1) return "0-1";
  if (ws <= 3) return "2-3";
  if (ws <= 5) return "4-5";
  return "6+";
}

// 空のアキュムレータを作成
export function newAccumulator() {
  return {
    racerStats: {},        // {reg: {...}}
    racerVenueStats: {},   // {"reg_venue": {...}}
    racerLaneStats: {},    // {"reg_lane": {...}}
    racerWeatherStats: {}, // {"reg_venue_weather_wsg": {...}}
    venueRaceStats: {},     // {"venue_rnum": {...}}
  };
}

// RaceResult配列をアキュムレータに蓄積
// raceWeatherMap: {race_id: {weather, wind_dir, wind_speed}} (Race天候データ)
export function accumulateResults(results, raceWeatherMap, acc) {
  for (const r of results) {
    if (r.data_source && r.data_source !== "official") continue;
    const reg = r.boat1_registration_number;
    if (!reg) continue;
    const venue = r.venue_code;
    const rnum = r.race_number;
    const won = r.result_1 === 1;
    const second = r.result_2 === 1;
    const third = r.result_3 === 1;
    const isUichi = !!r.is_uichi;
    // 裏ういち: 1-56-234（1-5/6-2/3/4）の6点
    const isUraUichi = r.result_1 === 1 && [5, 6].includes(r.result_2) && [2, 3, 4].includes(r.result_3);
    const st = r.boat1_avg_st;
    const fc = r.boat1_f_count || 0;
    const lc = r.boat1_l_count || 0;
    const hasSt = st != null && st > 0;

    // RacerStats
    let rs = acc.racerStats[reg];
    if (!rs) {
      rs = {
        registration_number: reg, racer_name: r.boat1_racer_name || "",
        total_races: 0, boat1_races: 0, boat1_wins: 0, boat1_2nd: 0, boat1_3rd: 0,
        uichi_count: 0, f_count: 0, l_count: 0, st_sum: 0, st_count: 0, recent: [],
      };
      acc.racerStats[reg] = rs;
    }
    rs.total_races++;
    rs.boat1_races++;
    if (won) rs.boat1_wins++;
    if (second) rs.boat1_2nd++;
    if (third) rs.boat1_3rd++;
    if (isUichi) rs.uichi_count++;
    if (fc > rs.f_count) rs.f_count = fc;
    if (lc > rs.l_count) rs.l_count = lc;
    if (hasSt) { rs.st_sum += st; rs.st_count++; }
    if (r.boat1_racer_name && !rs.racer_name) rs.racer_name = r.boat1_racer_name;
    rs.recent.push({ date: r.race_date, venue_code: venue, won, st, is_uichi: isUichi });

    // RacerVenueStats
    const rvk = `${reg}_${venue}`;
    let rvs = acc.racerVenueStats[rvk];
    if (!rvs) {
      rvs = {
        registration_number: reg, venue_code: venue, racer_name: r.boat1_racer_name || "",
        races: 0, boat1_races: 0, boat1_wins: 0, uichi_hits: 0, st_sum: 0, st_count: 0,
      };
      acc.racerVenueStats[rvk] = rvs;
    }
    rvs.races++;
    rvs.boat1_races++;
    if (won) rvs.boat1_wins++;
    if (isUichi) rvs.uichi_hits++;
    if (hasSt) { rvs.st_sum += st; rvs.st_count++; }
    if (r.boat1_racer_name && !rvs.racer_name) rvs.racer_name = r.boat1_racer_name;

    // RacerLaneStats (lane 1 only)
    const rlk = `${reg}_1`;
    let rls = acc.racerLaneStats[rlk];
    if (!rls) {
      rls = {
        registration_number: reg, lane: 1, races: 0, wins: 0, second: 0, third: 0, st_sum: 0, st_count: 0,
      };
      acc.racerLaneStats[rlk] = rls;
    }
    rls.races++;
    if (won) rls.wins++;
    if (second) rls.second++;
    if (third) rls.third++;
    if (hasSt) { rls.st_sum += st; rls.st_count++; }

    // VenueRaceStats
    const vrsk = `${venue}_${rnum}`;
    let vrs = acc.venueRaceStats[vrsk];
    if (!vrs) {
      vrs = { venue_code: venue, race_number: rnum, total_races: 0, uichi_hits: 0, ura_uichi_hits: 0, boat1_wins: 0 };
      acc.venueRaceStats[vrsk] = vrs;
    }
    vrs.total_races++;
    if (isUichi) vrs.uichi_hits++;
    if (isUraUichi) vrs.ura_uichi_hits++;
    if (won) vrs.boat1_wins++;

    // RacerWeatherStats
    const w = r.race_id ? raceWeatherMap[r.race_id] : null;
    if (w && w.weather) {
      const wsg = windSpeedGroup(w.wind_speed);
      const wk = `${reg}_${venue}_${w.weather}_${wsg}`;
      let rws = acc.racerWeatherStats[wk];
      if (!rws) {
        rws = {
          registration_number: reg, venue_code: venue, weather: w.weather,
          wind_speed_group: wsg, wind_dir: w.wind_dir || "", races: 0, wins: 0, st_sum: 0, st_count: 0,
        };
        acc.racerWeatherStats[wk] = rws;
      }
      rws.races++;
      if (won) rws.wins++;
      if (hasSt) { rws.st_sum += st; rws.st_count++; }
    }
  }
}

// アキュムレータの各レコードにレートを計算し、保存用配列に変換
export function finalizeAccumulator(acc, now) {
  const ts = now || new Date().toISOString();
  const out = { racerStats: [], racerVenueStats: [], racerLaneStats: [], racerWeatherStats: [], venueRaceStats: [] };

  for (const reg of Object.keys(acc.racerStats)) {
    const rs = acc.racerStats[reg];
    rs.boat1_win_rate = rs.boat1_races > 0 ? rs.boat1_wins / rs.boat1_races : 0;
    rs.boat1_2rate = rs.boat1_races > 0 ? (rs.boat1_wins + rs.boat1_2nd) / rs.boat1_races : 0;
    rs.boat1_3rate = rs.boat1_races > 0 ? (rs.boat1_wins + rs.boat1_2nd + rs.boat1_3rd) / rs.boat1_races : 0;
    rs.avg_st = rs.st_count > 0 ? rs.st_sum / rs.st_count : null;
    rs.recent_results = rs.recent.sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 20);
    rs.updated_at = ts;
    rs.stats_version = STATS_VERSION;
    delete rs.recent;
    delete rs.st_sum;
    out.racerStats.push(rs);
  }

  for (const k of Object.keys(acc.racerVenueStats)) {
    const rvs = acc.racerVenueStats[k];
    rvs.boat1_win_rate = rvs.boat1_races > 0 ? rvs.boat1_wins / rvs.boat1_races : 0;
    rvs.uichi_rate = rvs.boat1_races > 0 ? rvs.uichi_hits / rvs.boat1_races : 0;
    rvs.avg_st = rvs.st_count > 0 ? rvs.st_sum / rvs.st_count : null;
    rvs.updated_at = ts;
    rvs.stats_version = STATS_VERSION;
    delete rvs.st_sum;
    out.racerVenueStats.push(rvs);
  }

  for (const k of Object.keys(acc.racerLaneStats)) {
    const rls = acc.racerLaneStats[k];
    rls.win_rate = rls.races > 0 ? rls.wins / rls.races : 0;
    rls.second_rate = rls.races > 0 ? (rls.wins + rls.second) / rls.races : 0;
    rls.third_rate = rls.races > 0 ? (rls.wins + rls.second + rls.third) / rls.races : 0;
    rls.avg_st = rls.st_count > 0 ? rls.st_sum / rls.st_count : null;
    rls.updated_at = ts;
    rls.stats_version = STATS_VERSION;
    delete rls.st_sum;
    out.racerLaneStats.push(rls);
  }

  for (const k of Object.keys(acc.venueRaceStats)) {
    const vrs = acc.venueRaceStats[k];
    vrs.uichi_rate = vrs.total_races > 0 ? vrs.uichi_hits / vrs.total_races : 0;
    vrs.ura_uichi_rate = vrs.total_races > 0 ? (vrs.ura_uichi_hits || 0) / vrs.total_races : 0;
    vrs.boat1_win_rate = vrs.total_races > 0 ? vrs.boat1_wins / vrs.total_races : 0;
    vrs.updated_at = ts;
    vrs.stats_version = STATS_VERSION;
    out.venueRaceStats.push(vrs);
  }

  for (const k of Object.keys(acc.racerWeatherStats)) {
    const rws = acc.racerWeatherStats[k];
    rws.win_rate = rws.races > 0 ? rws.wins / rws.races : 0;
    rws.avg_st = rws.st_count > 0 ? rws.st_sum / rws.st_count : null;
    rws.updated_at = ts;
    rws.stats_version = STATS_VERSION;
    delete rws.st_sum;
    out.racerWeatherStats.push(rws);
  }

  return out;
}

// 既存レコードに日次差分をマージ（既存 + day → 更新）
// existingMap: {key: record}, dayRecords: [{...finalize済み}]
// entityごとのマージ関数
export function mergeRacerStats(existing, day) {
  existing.boat1_races = (existing.boat1_races || 0) + day.boat1_races;
  existing.boat1_wins = (existing.boat1_wins || 0) + day.boat1_wins;
  existing.boat1_2nd = (existing.boat1_2nd || 0) + day.boat1_2nd;
  existing.boat1_3rd = (existing.boat1_3rd || 0) + day.boat1_3rd;
  existing.total_races = (existing.total_races || 0) + day.total_races;
  existing.uichi_count = (existing.uichi_count || 0) + day.uichi_count;
  if (day.f_count > (existing.f_count || 0)) existing.f_count = day.f_count;
  if (day.l_count > (existing.l_count || 0)) existing.l_count = day.l_count;
  // avg_st: running weighted
  const exStCount = existing.st_count || 0;
  const dayStCount = day.st_count || 0;
  if (dayStCount > 0) {
    const exStSum = (existing.avg_st || 0) * exStCount;
    const newCount = exStCount + dayStCount;
    existing.avg_st = newCount > 0 ? (exStSum + day.avg_st * dayStCount) / newCount : null;
    existing.st_count = newCount;
  }
  // recent_results: merge and re-sort
  const merged = [...(day.recent_results || []), ...(existing.recent_results || [])];
  existing.recent_results = merged.sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 20);
  // recompute rates
  existing.boat1_win_rate = existing.boat1_races > 0 ? existing.boat1_wins / existing.boat1_races : 0;
  existing.boat1_2rate = existing.boat1_races > 0 ? (existing.boat1_wins + existing.boat1_2nd) / existing.boat1_races : 0;
  existing.boat1_3rate = existing.boat1_races > 0 ? (existing.boat1_wins + existing.boat1_2nd + existing.boat1_3rd) / existing.boat1_races : 0;
  existing.updated_at = new Date().toISOString();
  existing.stats_version = STATS_VERSION;
  return existing;
}

export function mergeRacerVenueStats(existing, day) {
  existing.races = (existing.races || 0) + day.races;
  existing.boat1_races = (existing.boat1_races || 0) + day.boat1_races;
  existing.boat1_wins = (existing.boat1_wins || 0) + day.boat1_wins;
  existing.uichi_hits = (existing.uichi_hits || 0) + day.uichi_hits;
  const exStCount = existing.st_count || 0;
  const dayStCount = day.st_count || 0;
  if (dayStCount > 0) {
    const exStSum = (existing.avg_st || 0) * exStCount;
    const newCount = exStCount + dayStCount;
    existing.avg_st = newCount > 0 ? (exStSum + day.avg_st * dayStCount) / newCount : null;
    existing.st_count = newCount;
  }
  existing.boat1_win_rate = existing.boat1_races > 0 ? existing.boat1_wins / existing.boat1_races : 0;
  existing.uichi_rate = existing.boat1_races > 0 ? existing.uichi_hits / existing.boat1_races : 0;
  existing.updated_at = new Date().toISOString();
  existing.stats_version = STATS_VERSION;
  return existing;
}

export function mergeRacerLaneStats(existing, day) {
  existing.races = (existing.races || 0) + day.races;
  existing.wins = (existing.wins || 0) + day.wins;
  existing.second = (existing.second || 0) + day.second;
  existing.third = (existing.third || 0) + day.third;
  const exStCount = existing.st_count || 0;
  const dayStCount = day.st_count || 0;
  if (dayStCount > 0) {
    const exStSum = (existing.avg_st || 0) * exStCount;
    const newCount = exStCount + dayStCount;
    existing.avg_st = newCount > 0 ? (exStSum + day.avg_st * dayStCount) / newCount : null;
    existing.st_count = newCount;
  }
  existing.win_rate = existing.races > 0 ? existing.wins / existing.races : 0;
  existing.second_rate = existing.races > 0 ? (existing.wins + existing.second) / existing.races : 0;
  existing.third_rate = existing.races > 0 ? (existing.wins + existing.second + existing.third) / existing.races : 0;
  existing.updated_at = new Date().toISOString();
  existing.stats_version = STATS_VERSION;
  return existing;
}

export function mergeVenueRaceStats(existing, day) {
  existing.total_races = (existing.total_races || 0) + day.total_races;
  existing.uichi_hits = (existing.uichi_hits || 0) + day.uichi_hits;
  existing.ura_uichi_hits = (existing.ura_uichi_hits || 0) + (day.ura_uichi_hits || 0);
  existing.boat1_wins = (existing.boat1_wins || 0) + day.boat1_wins;
  existing.uichi_rate = existing.total_races > 0 ? existing.uichi_hits / existing.total_races : 0;
  existing.ura_uichi_rate = existing.total_races > 0 ? (existing.ura_uichi_hits || 0) / existing.total_races : 0;
  existing.boat1_win_rate = existing.total_races > 0 ? existing.boat1_wins / existing.total_races : 0;
  existing.updated_at = new Date().toISOString();
  existing.stats_version = STATS_VERSION;
  return existing;
}

export function mergeRacerWeatherStats(existing, day) {
  existing.races = (existing.races || 0) + day.races;
  existing.wins = (existing.wins || 0) + day.wins;
  const exStCount = existing.st_count || 0;
  const dayStCount = day.st_count || 0;
  if (dayStCount > 0) {
    const exStSum = (existing.avg_st || 0) * exStCount;
    const newCount = exStCount + dayStCount;
    existing.avg_st = newCount > 0 ? (exStSum + day.avg_st * dayStCount) / newCount : null;
    existing.st_count = newCount;
  }
  existing.win_rate = existing.races > 0 ? existing.wins / existing.races : 0;
  existing.updated_at = new Date().toISOString();
  existing.stats_version = STATS_VERSION;
  return existing;
}