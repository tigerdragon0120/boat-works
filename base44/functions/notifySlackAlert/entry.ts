import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function fmtPct(v) {
  return v == null ? '—' : `${(Number(v) * (Number(v) <= 1 ? 100 : 1)).toFixed(1)}%`;
}
function fmtNum(v, d = 0) {
  return v == null ? '—' : Number(v).toFixed(d);
}
function fmtJstTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

async function resolveChannelId(base44, channelName) {
  const name = String(channelName || 'all-boat-works').replace(/^#/, '');
  let cursor = '';
  for (let i = 0; i < 5; i++) {
    const res = await base44.asServiceRole.connectors.callApi('slack', {
      method: 'GET',
      path: '/api/conversations.list',
      query: {
        types: 'public_channel',
        exclude_archived: 'true',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      },
    });
    const data = res?.data || {};
    const found = (data.channels || []).find((c) => c?.name === name);
    if (found?.id) return found.id;
    cursor = data?.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  throw new Error(`Slack channel #${name} not found`);
}

async function postSlack(base44, channelId, text) {
  const res = await base44.asServiceRole.connectors.callApi('slack', {
    method: 'POST',
    path: '/api/chat.postMessage',
    body: { channel: channelId, text, unfurl_links: false, unfurl_media: false },
  });
  const data = res?.data || {};
  if (!data.ok) throw new Error(data.error || 'Slack post failed');
  return data;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const raceId = body.race_id;
    const stage = body.stage || 'final';
    if (!raceId) return Response.json({ status: 'error', message: 'race_id required' }, { status: 400 });

    const settingsList = await base44.asServiceRole.entities.AppSettings.filter({ is_active_config: true }, null, 1);
    const settings = settingsList[0] || {};
    if (settings.slack_notification_on === false) return Response.json({ sent: false, reason: 'slack_off' });
    if (stage === 'pre' && settings.slack_pre_notify === false) return Response.json({ sent: false, reason: 'pre_off' });
    if (stage === 'final' && settings.slack_final_notify === false) return Response.json({ sent: false, reason: 'final_off' });
    if (stage === 'result' && settings.slack_result_notify === false) return Response.json({ sent: false, reason: 'result_off' });

    const alerts = await base44.asServiceRole.entities.Alert.filter({ race_id: raceId }, '-created_date', 5);
    const alert = alerts[0] || null;
    if (stage === 'pre' && alert?.slack_pre_notified) return Response.json({ sent: false, reason: 'already_pre_notified' });
    if (stage === 'final' && alert?.slack_final_notified) return Response.json({ sent: false, reason: 'already_final_notified' });
    if (stage === 'result' && alert?.slack_result_notified) return Response.json({ sent: false, reason: 'already_result_notified' });

    const analysisStage = stage === 'result' ? 'final' : stage;
    const analyses = await base44.asServiceRole.entities.UichiAnalysis.filter({ race_id: raceId, stage: analysisStage }, '-captured_at', 10);
    const a = analyses[0];
    if (!a) return Response.json({ sent: false, reason: 'no_analysis' });

    if (stage === 'pre' && !['S', 'A'].includes(a.pre_grade)) {
      return Response.json({ sent: false, reason: 'not_pre_candidate' });
    }
    if (stage === 'final' && !['BUY', 'WATCH'].includes(a.judgment)) {
      return Response.json({ sent: false, reason: 'not_final_candidate' });
    }
    if (stage === 'result' && a.judgment !== 'BUY') {
      return Response.json({ sent: false, reason: 'not_buy_result' });
    }

    const race = await base44.asServiceRole.entities.Race.get(raceId);
    const channelName = settings.slack_channel_name || 'all-boat-works';
    const channelId = await resolveChannelId(base44, channelName);

    let text;
    let resultHit = null;
    if (stage === 'pre') {
      text = [
        `🚤 *BOAT WORKS 前日候補*  ${race.venue_name} ${race.race_number}R`,
        `事前評価 *${a.pre_grade}* / ういち出現率 ${fmtPct(a.appearance_rate)}`,
        `1号艇 ${a.boat1_racer_name || '—'} / 信頼スコア *${a.boat1_trust_score ?? '—'}* / 条件一致 ${a.condition_match_score ?? '—'}%`,
        `5/6穴期待 *${a.outer_boat_score ?? '—'}* / 注目 ${a.outer_boat_number ? `${a.outer_boat_number}号艇 ${a.outer_boat_name || ''}` : '—'}`,
        `締切 ${fmtJstTime(race.deadline)} / 最終判定 ${fmtJstTime(new Date(new Date(race.deadline).getTime() - 10 * 60 * 1000).toISOString())}`, 
      ].join('\n');
    } else if (stage === 'final') {
      const icon = a.judgment === 'BUY' ? '🔥' : '⚠️';
      const side = a.recommended_pattern === 'URA' ? '裏ういち 1-56-234' : a.recommended_pattern === 'MAIN' ? '本線ういち 1-234-56' : '中立';
      text = [
        `${icon} *BOAT WORKS ${a.judgment}*  ${race.venue_name} ${race.race_number}R`,
        `推奨 *${side}*`,
        `合成オッズ *${fmtNum(a.synthetic_odds, 2)}倍* / EV *${fmtNum(a.expected_value, 0)}%* / 出現率 ${fmtPct(a.appearance_rate)}`,
        `1号艇 ${a.boat1_racer_name || '—'} / 信頼スコア *${a.boat1_trust_score ?? '—'}*`,
        `締切 ${fmtJstTime(race.deadline)}（締切10分前までに最終判定）`, 
      ].join('\n');
    } else {
      let results = await base44.asServiceRole.entities.RaceResult.filter({ race_id: raceId, data_source: 'official' }, '-created_date', 5);
      // Historical/result取得系では race_id が YYYY-MM-DD_JCD_R の複合キーになる場合があるため、
      // 本体Race.idで見つからないときは日付＋場＋R番号で公式結果を照合する。
      if (!results.length) {
        results = await base44.asServiceRole.entities.RaceResult.filter({
          race_date: race.race_date,
          venue_code: String(race.venue_code).padStart(2, '0'),
          race_number: Number(race.race_number),
          data_source: 'official',
        }, '-created_date', 5);
      }
      const result = results[0];
      if (!result) return Response.json({ sent: false, reason: 'no_result' });
      const r1 = Number(result.result_1 || 0), r2 = Number(result.result_2 || 0), r3 = Number(result.result_3 || 0);
      const mainHit = r1 === 1 && [2,3,4].includes(r2) && [5,6].includes(r3);
      const uraHit = r1 === 1 && [5,6].includes(r2) && [2,3,4].includes(r3);
      resultHit = a.recommended_pattern === 'MAIN' ? mainHit : a.recommended_pattern === 'URA' ? uraHit : false;
      if (!resultHit) return Response.json({ sent: false, reason: 'buy_missed' });
      const side = a.recommended_pattern === 'URA' ? '裏ういち' : '本線ういち';
      const trifecta = result.trifecta || `${r1}-${r2}-${r3}`;
      const payout = Number(result.payout_trifecta || 0);
      text = [
        `🎯 *BOAT WORKS BUY 的中！*  ${race.venue_name} ${race.race_number}R`,
        `推奨 *${side}* → 結果 *${trifecta}*`,
        `3連単払戻 *${payout > 0 ? payout.toLocaleString('ja-JP') : '—'}円*`,
        `最終EV ${fmtNum(a.expected_value, 0)}% / 合成オッズ ${fmtNum(a.synthetic_odds, 2)}倍`,
      ].join('\n');
    }

    const posted = await postSlack(base44, channelId, text);
    const update = stage === 'pre'
      ? { slack_pre_notified: true, slack_pre_ts: posted.ts || null }
      : stage === 'final'
        ? { slack_final_notified: true, slack_final_ts: posted.ts || null, final_judgment: a.judgment, final_expected_value: a.expected_value, synthetic_odds: a.synthetic_odds, recommended_pattern: a.recommended_pattern }
        : { slack_result_notified: true, slack_result_ts: posted.ts || null, slack_result_hit: !!resultHit };

    if (alert) await base44.asServiceRole.entities.Alert.update(alert.id, update);
    else await base44.asServiceRole.entities.Alert.create({
      race_id: race.id, race_date: race.race_date, venue_code: race.venue_code,
      venue_name: race.venue_name, race_number: race.race_number, deadline: race.deadline,
      status: 'active', notified: false, ...update,
    });

    return Response.json({ sent: true, stage, channel: `#${channelName}`, ts: posted.ts, text });
  } catch (error) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}
