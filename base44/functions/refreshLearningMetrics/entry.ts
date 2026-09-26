import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const MIN_SAMPLE = 100;
const pct = (n, d) => d > 0 ? n / d : 0;
const bucket = (v) => {
  const n = Number(v || 0);
  if (n < 40) return '0-39';
  if (n < 50) return '40-49';
  if (n < 60) return '50-59';
  if (n < 70) return '60-69';
  if (n < 80) return '70-79';
  return '80-100';
};

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({ status:'error', message:'管理者権限が必要です' }, { status:403 });

    const samples = await base44.asServiceRole.entities.UichiLearningSample.filter(
      { outcome_pattern: { $ne: 'PENDING' } }, '-race_date', 5000
    ).catch(() => []);

    const groups = new Map();
    const add = (dimension, value, s) => {
      const key = `${dimension}:${value}`;
      if (!groups.has(key)) groups.set(key, { metric_key:key, dimension, value, rows:[] });
      groups.get(key).rows.push(s);
    };

    for (const s of samples) {
      add('program_hypothesis', s.program_hypothesis || 'UNKNOWN', s);
      add('scenario_status', s.program_scenario_status || 'UNKNOWN', s);
      add('recommended_pattern', s.recommended_pattern || 'UNKNOWN', s);
      add('intent_confidence_bucket', bucket(s.program_intent_confidence), s);
      add('escape_execution_bucket', bucket(s.racer_escape_execution), s);
      add('direction_confidence_bucket', bucket(s.direction_confidence), s);
      add('hypothesis_x_escape', `${s.program_hypothesis || 'UNKNOWN'}|${bucket(s.racer_escape_execution)}`, s);
      add('scenario_x_pattern', `${s.program_scenario_status || 'UNKNOWN'}|${s.recommended_pattern || 'UNKNOWN'}`, s);
      add('logic_mode', s.logic_mode || 'OTHER', s);
      add('series_day', String(s.series_day || 0), s);
      add('logic_x_pattern', `${s.logic_mode || 'OTHER'}|${s.recommended_pattern || 'UNKNOWN'}`, s);
      add('venue_x_logic', `${s.venue_code || '00'}|${s.logic_mode || 'OTHER'}`, s);
    }

    const existing = await base44.asServiceRole.entities.UichiLearningMetric.list('metric_key', 1000).catch(() => []);
    const exMap = new Map(existing.map(x => [x.metric_key, x]));
    const updates = [], creates = [];
    const now = new Date().toISOString();

    for (const g of groups.values()) {
      const rows = g.rows;
      const n = rows.length;
      const boat1Wins = rows.filter(x => x.boat1_win === true).length;
      const mainHits = rows.filter(x => x.main_hit === true).length;
      const uraHits = rows.filter(x => x.ura_hit === true).length;
      const newMainHits = rows.filter(x => x.new_main_hit === true).length;
      const newUraHits = rows.filter(x => x.new_ura_hit === true).length;
      const recHits = rows.filter(x => x.recommended_hit === true).length;
      const falseSkips = rows.filter(x => x.false_skip === true).length;
      const falseWatches = rows.filter(x => x.false_watch === true).length;
      const patternRates = { MAIN:pct(mainHits,n), URA:pct(uraHits,n), NEW_MAIN:pct(newMainHits,n), NEW_URA:pct(newUraHits,n) };
      const candidate = Object.entries(patternRates).sort((a,b)=>b[1]-a[1])[0] || ['NONE',0];
      const candidateStatus = n >= MIN_SAMPLE ? 'RELIABLE' : n >= 30 ? 'CANDIDATE' : 'LEARNING';
      const payload = {
        metric_key:g.metric_key, dimension:g.dimension, value:g.value,
        sample_count:n,
        boat1_win_count:boat1Wins, boat1_win_rate:pct(boat1Wins,n),
        main_hit_count:mainHits, main_hit_rate:pct(mainHits,n),
        ura_hit_count:uraHits, ura_hit_rate:pct(uraHits,n),
        new_main_hit_count:newMainHits, new_main_hit_rate:pct(newMainHits,n),
        new_ura_hit_count:newUraHits, new_ura_hit_rate:pct(newUraHits,n),
        recommended_hit_count:recHits, recommended_hit_rate:pct(recHits,n),
        false_skip_count:falseSkips, false_skip_rate:pct(falseSkips,n),
        false_watch_count:falseWatches, false_watch_rate:pct(falseWatches,n),
        candidate_pattern:candidate[0], candidate_lift:candidate[1], candidate_status:candidateStatus,
        reliable:n >= MIN_SAMPLE, min_sample:MIN_SAMPLE,
        analysis_version:'v8',
        last_sample_date:rows[0]?.race_date || null,
        updated_at:now,
      };
      const ex = exMap.get(g.metric_key);
      if (ex) updates.push({ id:ex.id, ...payload }); else creates.push(payload);
    }

    if (updates.length) await base44.asServiceRole.entities.UichiLearningMetric.bulkUpdate(updates);
    if (creates.length) await base44.asServiceRole.entities.UichiLearningMetric.bulkCreate(creates);

    return Response.json({ status:'success', samples:samples.length, metrics:groups.size, reliable_metrics:[...groups.values()].filter(g=>g.rows.length>=MIN_SAMPLE).length, min_sample:MIN_SAMPLE });
  } catch (error) {
    return Response.json({ status:'error', message:error.message }, { status:500 });
  }
}
