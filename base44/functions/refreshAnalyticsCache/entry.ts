import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const t0 = Date.now();
    const [analysisRes, trendsRes] = await Promise.all([
      base44.asServiceRole.functions.invoke('getAnalysisStats', { force_refresh: true }),
      base44.asServiceRole.functions.invoke('getUichiTrends', { force_refresh: true }),
    ]);

    const analysis = analysisRes?.data || analysisRes;
    const trends = trendsRes?.data || trendsRes;

    return Response.json({
      status: 'success',
      analysis_total: analysis?.total || 0,
      trends_total: trends?.overall?.total || 0,
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
