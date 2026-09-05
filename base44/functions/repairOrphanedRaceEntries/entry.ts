import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// 孤立RaceEntry（race_idが現存しないRaceを指しているレコード）の修復。
// 重複Race解消時に子データ移行が漏れた場合などに発生する。
//
// 方針（データを壊さない安全側の設計）：
// 1. その日付のRaceを全件取得し、有効なrace_id集合を作る
// 2. race_idがその集合に無いRaceEntryを「孤立」とみなす
// 3. 孤立entryは venue_code+race_number から正規Raceを特定し、
//    - 正規Race側にその艇番の出走情報がまだ無ければ → race_idを付け替えて救済
//    - 既にあれば → 展示情報（entry_course/exhibition_time/tilt/exhibition_st等）が
//      欠けている側に補完し、孤立entryは削除（重複解消）
// 4. 正規Raceが見つからない（レース自体が丸ごと消えている）場合は削除せず、
//    unresolvedとして報告のみ行う（delete_unresolved=trueを明示した場合のみ削除）

function pickExhibition(a, b) {
  // aを優先しつつ、値が欠けている項目をbで補完
  return {
    entry_course: a?.entry_course ?? b?.entry_course ?? null,
    exhibition_time: a?.exhibition_time ?? b?.exhibition_time ?? null,
    tilt: a?.tilt ?? b?.tilt ?? null,
    exhibition_st: a?.exhibition_st ?? b?.exhibition_st ?? null,
    exhibition_st_raw: a?.exhibition_st_raw ?? b?.exhibition_st_raw ?? null,
    exhibition_rank: a?.exhibition_rank ?? b?.exhibition_rank ?? null,
    is_scratched: a?.is_scratched === true || b?.is_scratched === true,
  };
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});

    const body = await req.json().catch(() => ({}));
    const urlParams = new URL(req.url).searchParams;
    const raceDate = body.race_date || urlParams.get('race_date');
    const deleteUnresolved = body.delete_unresolved === true || urlParams.get('delete_unresolved') === 'true';
    if (!raceDate) return Response.json({status:'error',message:'race_date required'},{status:400});

    const races = await base44.asServiceRole.entities.Race.filter({race_date:raceDate}, '-updated_date', 500).catch(()=>[]);
    const validRaceIds = new Set(races.map(r => r.id));
    const canonicalByKey = new Map();
    for (const r of races) {
      const key = `${r.venue_code}_${r.race_number}`;
      const cur = canonicalByKey.get(key);
      if (!cur || new Date(r.updated_date || 0) > new Date(cur.updated_date || 0)) {
        canonicalByKey.set(key, r);
      }
    }

    const entries = await base44.asServiceRole.entities.RaceEntry.filter({race_date:raceDate}, 'race_id', 2000).catch(()=>[]);
    const orphans = entries.filter(e => !validRaceIds.has(e.race_id));

    let relinked = 0, merged = 0, unresolved = 0, deleted = 0;
    const unresolvedList = [];

    const canonicalEntriesCache = new Map();
    async function getCanonicalEntries(raceId) {
      if (canonicalEntriesCache.has(raceId)) return canonicalEntriesCache.get(raceId);
      const rows = await base44.asServiceRole.entities.RaceEntry.filter({race_id:raceId}, 'boat_number', 20).catch(()=>[]);
      const map = new Map(rows.map(r => [Number(r.boat_number), r]));
      canonicalEntriesCache.set(raceId, map);
      return map;
    }

    for (const orphan of orphans) {
      const key = `${orphan.venue_code}_${orphan.race_number}`;
      const canonical = canonicalByKey.get(key);

      if (!canonical) {
        unresolved++;
        unresolvedList.push({id:orphan.id, venue_code:orphan.venue_code, race_number:orphan.race_number, boat_number:orphan.boat_number});
        if (deleteUnresolved) {
          await base44.asServiceRole.entities.RaceEntry.delete(orphan.id).catch(()=>{});
          deleted++;
        }
        continue;
      }

      const canonicalEntries = await getCanonicalEntries(canonical.id);
      const existing = canonicalEntries.get(Number(orphan.boat_number));

      if (!existing) {
        await base44.asServiceRole.entities.RaceEntry.update(orphan.id, {race_id: canonical.id}).catch(()=>{});
        canonicalEntries.set(Number(orphan.boat_number), {...orphan, race_id: canonical.id});
        relinked++;
      } else {
        const mergedFields = pickExhibition(existing, orphan);
        await base44.asServiceRole.entities.RaceEntry.update(existing.id, mergedFields).catch(()=>{});
        await base44.asServiceRole.entities.RaceEntry.delete(orphan.id).catch(()=>{});
        merged++;
        deleted++;
      }
    }

    return Response.json({
      status: 'success',
      race_date: raceDate,
      total_races: races.length,
      total_entries_checked: entries.length,
      orphans_found: orphans.length,
      relinked, merged, unresolved, deleted,
      unresolved_list: unresolvedList,
    });
  } catch(e) {
    return Response.json({status:'error',message:e?.message || String(e)},{status:500});
  }
}
