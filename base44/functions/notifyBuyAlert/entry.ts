import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// BUY/WATCH判定時にスマホへプッシュ通知を送信
// AppSettingsの通知条件でフィルタリング:
//   - notification_on: 通知全体のON/OFF
//   - notify_min_ev: 期待値指数がこれ未満なら通知しない
//   - notify_min_trust_score: 信頼スコアがこれ未満なら通知しない (0=无条件)
//   - notify_only_strong: STRONG BUY(信頼スコア≥trust_strong_threshold)のみ通知
//   - notify_watch: WATCH判定も通知する (falseならBUYのみ)
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const raceId = body.race_id;
    if (!raceId) return Response.json({ error: 'race_id required' }, { status: 400 });

    // 設定取得
    const settingsList = await base44.entities.AppSettings.filter({ is_active_config: true }, null, 1);
    const settings = settingsList[0] || {};
    if (settings.notification_on === false) return Response.json({ sent: false, reason: "notification_off" });

    // final分析を取得
    const analyses = await base44.entities.UichiAnalysis.filter({ race_id: raceId, stage: "final" });
    const final = analyses[0];
    if (!final) return Response.json({ sent: false, reason: "no_final" });

    const isBuy = final.judgment === "BUY";
    const isWatch = final.judgment === "WATCH";
    const allowWatch = settings.notify_watch === true;
    if (!isBuy && !(isWatch && allowWatch)) {
      return Response.json({ sent: false, reason: "not_target_judgment" });
    }

    // 期待値しきい値チェック
    const minEv = Number(settings.notify_min_ev ?? 110);
    if (final.expected_value != null && final.expected_value < minEv) {
      return Response.json({ sent: false, reason: "ev_below_threshold", ev: final.expected_value, threshold: minEv });
    }

    // 信頼スコアしきい値チェック
    const minTrust = Number(settings.notify_min_trust_score ?? 0);
    if (minTrust > 0 && final.boat1_trust_score != null && final.boat1_trust_score < minTrust) {
      return Response.json({ sent: false, reason: "trust_below_threshold", trust: final.boat1_trust_score, threshold: minTrust });
    }

    // STRONG BUYのみ通知チェック
    if (settings.notify_only_strong === true) {
      const strongThreshold = Number(settings.trust_strong_threshold ?? 85);
      if (final.boat1_trust_score == null || final.boat1_trust_score < strongThreshold) {
        return Response.json({ sent: false, reason: "not_strong", trust: final.boat1_trust_score, threshold: strongThreshold });
      }
    }

    // 既に通知済みか確認（二重送信防止）
    const alerts = await base44.entities.Alert.filter({ race_id: raceId });
    const alert = alerts[0];
    if (alert?.notified) return Response.json({ sent: false, reason: "already_notified" });

    // プッシュ通知送信
    const label = isBuy ? "BUY" : "WATCH";
    const title = `${isBuy ? "🔥" : "⚠️"} ${label} ${final.venue_name} ${final.race_number}R`;
    const evPct = final.expected_value != null ? Math.round(final.expected_value) : "—";
    const content = `EV ${evPct}% / 1号艇信頼 ${final.boat1_trust_score ?? "—"} / 締切10分前までに最終確定`;

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
        final_judgment: final.judgment,
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
        final_judgment: final.judgment,
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