import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// BOAT WORKS 過去1号艇詳細の自動補完
// 1回あたり最大6開催場日を処理。新しい日付を優先し、毎時実行して徐々に100%へ近づける。
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const limit = Math.max(1, Math.min(Number(body.limit || 6), 12));

    const progress = await base44.asServiceRole.entities.FetchProgress.list('-race_date', 5000);
    const candidates = progress
      .filter((p:any) => p.venue_code !== '00')
      .filter((p:any) => p.result_fetch_status === 'done' || p.status === 'done')
      .filter((p:any) => p.detail_fetch_status !== 'done' && p.detail_fetch_status !== 'skip')
      .sort((a:any,b:any) => String(b.race_date || '').localeCompare(String(a.race_date || '')))
      .slice(0, limit);

    if (candidates.length === 0) {
      // 旧1号艇詳細の補完対象が無い時も、過去フルスペックDBを止めない。
      // 専用Workflowが何らかの理由で発火しなくても、この毎時Workerから過去へ進める。
      let historical = null;
      try {
        const h = await base44.asServiceRole.functions.invoke('runHistoricalFrontierBackfill', { limit: 2 });
        historical = h?.data || h;
      } catch (e:any) {
        historical = { status: 'error', message: e?.message || String(e) };
      }
      return Response.json({ status: 'success', processed: 0, enriched: 0, errors: 0, message: '補完対象なし', historical_full_spec: historical });
    }

    let processed = 0, enriched = 0, errors = 0;
    const details:any[] = [];

    for (let i = 0; i < candidates.length; i += 2) {
      const batch = candidates.slice(i, i + 2);
      const rs = await Promise.all(batch.map(async (p:any) => {
        try {
          const res = await base44.asServiceRole.functions.invoke('enrichBoat1Details', {
            race_date: p.race_date,
            jcd: p.venue_code,
            limit: 12,
            error_mode: p.detail_fetch_status === 'error',
          });
          return { p, data: res?.data || res };
        } catch (e:any) {
          return { p, data: { status: 'error', message: e?.message || 'error' } };
        }
      }));

      for (const r of rs) {
        processed++;
        const d = r.data || {};
        enriched += Number(d.enriched || 0);
        errors += Number(d.errors || (d.status === 'error' ? 1 : 0));
        details.push({ race_date: r.p.race_date, venue_code: r.p.venue_code, status: d.status, enriched: d.enriched || 0, errors: d.errors || 0 });
      }
    }

    // 専用Historical Full Spec Backfill Workflowだけに依存しない冗長経路。
    // 毎時の既存Workerが動くたび、同じ「前線の日付」を最大2開催場だけ進める。
    let historical = null;
    try {
      const h = await base44.asServiceRole.functions.invoke('runHistoricalFrontierBackfill', { limit: 2 });
      historical = h?.data || h;
    } catch (e:any) {
      historical = { status: 'error', message: e?.message || String(e) };
    }

    return Response.json({ status: 'success', processed, enriched, errors, details, historical_full_spec: historical });
  } catch (error:any) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
