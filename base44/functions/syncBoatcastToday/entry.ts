import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';

// BOAT WORKS: 当日のBOATCAST自動同期
// syncBoatcastDay(当日: Race生成+展示/オッズ/結果)を呼び出す
// 翌日同期は "BOATCAST Tomorrow Sync" ワークフローで別途実行

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ ok: false, error: '管理者権限が必要です' }, { status: 403 });
    }

    // 当日同期(Race生成 + 展示/オッズ/結果)
    const result = await base44.asServiceRole.functions.invoke('syncBoatcastDay', {
      target_offset: 0,
      sync_details: true,
    });

    const data = result?.data || result;
    return Response.json(data);
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}