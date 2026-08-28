import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { STATS_VERSION } from '../../shared/aggregation.js';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const meta = await base44.asServiceRole.entities.AggregationMeta.filter({ config_id: 'main' });
    const current = Number(meta[0]?.stats_version || 0);
    if (current >= STATS_VERSION && meta[0]?.status !== 'error') {
      return Response.json({ status: 'current', stats_version: current });
    }

    const res = await base44.asServiceRole.functions.invoke('buildAggregates', {});
    const out = res?.data || res;
    return Response.json({ status: out?.status || 'done', stats_version: STATS_VERSION, result: out });
  } catch (error) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}
