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

    const alerts = await base44.asServiceRole.entities.Alert.filter({ race_id: raceId }, '-created_date', 5);
    const alert = alerts[0] || null;
    if (stage === 'pre' && alert?.slack_pre_notified) return Response.json({ sent: false, reason: 'already_pre_notified' });
    if (stage === 'final' && alert?.slack_final_notified) return Response.json({ sent: false, reason: 'already_final_notified' });

    const analyses = await base44.asServiceRole.entities.UichiAnalysis.filter({ race_id: raceId, stage }, '-captured_at', 10);
    const a = analyses[0];
    if (!a) return Response.json({ sent: false, reason: 'no_analysis' });

    if (stage === 'pre' && !['S', 'A'].includes(a.pre_grade)) {
      return Response.json({ sent: false, reason: 'not_pre_candidate' });
    }
    if (stage === 'final' && !['BUY', 'WATCH'].includes(a.judgment)) {
      return Response.json({ sent: false, reason: 'not_final_candidate' });
    }

    const race = await base44.asServiceRole.entities.Race.get(raceId);
    const channelName = settings.slack_channel_name || 'all-boat-works';
    const channelId = await resolveChannelId(base44, channelName);

    let text;
    if (stage === 'pre') {
      text = [
        `🚤 *BOAT WORKS 前日候補*  ${race.venue_name} ${race.race_number}R`,
        `事前評価 *${a.pre_grade}* / ういち出現率 ${fmtPct(a.appearance_rate)}`,
        `1号艇 ${a.boat1_racer_name || '—'} / 信頼スコア *${a.boat1_trust_score ?? '—'}* / 条件一致 ${a.condition_match_score ?? '—'}%`,
        `締切 ${fmtJstTime(race.deadline)} / 最終判定 ${fmtJstTime(new Date(new Date(race.deadline).getTime() - 5 * 60 * 1000).toISOString())}`,
      ].join('\n');
    } else {
      const icon = a.judgment === 'BUY' ? '🔥' : '⚠️';
      text = [
        `${icon} *BOAT WORKS ${a.judgment}*  ${race.venue_name} ${race.race_number}R`,
        `合成オッズ *${fmtNum(a.synthetic_odds, 2)}倍* / EV *${fmtNum(a.expected_value, 0)}%* / ういち率 ${fmtPct(a.appearance_rate)}`,
        `1号艇 ${a.boat1_racer_name || '—'} / 信頼スコア *${a.boat1_trust_score ?? '—'}* / 条件一致 ${a.condition_match_score ?? '—'}%`,
        `締切 ${fmtJstTime(race.deadline)}（締切5分前の最終判定）`,
      ].join('\n');
    }

    const posted = await postSlack(base44, channelId, text);
    const update = stage === 'pre'
      ? { slack_pre_notified: true, slack_pre_ts: posted.ts || null }
      : { slack_final_notified: true, slack_final_ts: posted.ts || null };

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
