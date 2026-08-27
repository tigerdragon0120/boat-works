import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// BUY判定時にスマホへプッシュ通知を送信
// 1. final分析のjudgmentがBUYか確認
// 2. Alert.notifiedフラグで二重送信防止
// 3. SendPushNotificationで現在のユーザーへ通知
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const raceId = body.race_id;
    if (!raceId) return Response.json({ error: 'race_id required' }, { status: 400 });

    // final分析を取得
    const analyses = await base44.entities.UichiAnalysis.filter({ race_id: raceId, stage: "final" });
    const final = analyses[0];
    if (!final) return Response.json({ sent: false, reason: "no_final" });
    if (final.judgment !== "BUY") return Response.json({ sent: false, reason: "not_buy" });

    // 既に通知済みか確認（二重送信防止）
    const alerts = await base44.entities.Alert.filter({ race_id: raceId });
    const alert = alerts[0];
    if (alert?.notified) return Response.json({ sent: false, reason: "already_notified" });

    // プッシュ通知送信
    const title = `🔥 BUY ${final.venue_name} ${final.race_number}R`;
    const evPct = final.expected_value != null ? Math.round(final.expected_value) : "—";
    const content = `EV ${evPct}% / 1号艇信頼 ${final.boat1_trust_score ?? "—"} / 締切5分前です`;

    await base44.asServiceRole.integrations.Core.SendPushNotification({
      user_id: user.id,
      title,
      content,
      action_label: "詳細を見る",
      action_url: `/race/${raceId}`,
    });

    // 通知済みフラグを更新
    if (alert) {
      await base44.entities.Alert.update(alert.id, {
        notified: true,
        final_judgment: "BUY",
        final_expected_value: final.expected_value,
        synthetic_odds: final.synthetic_odds,
      });
    } else {
      await base44.entities.Alert.create({
        race_id: raceId,
        race_date: final.race_date,
        venue_code: final.venue_code,
        venue_name: final.venue_name,
        race_number: final.race_number,
        deadline: body.deadline || null,
        final_judgment: "BUY",
        final_expected_value: final.expected_value,
        synthetic_odds: final.synthetic_odds,
        notified: true,
        status: "active",
      });
    }

    return Response.json({ sent: true, title, content });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}