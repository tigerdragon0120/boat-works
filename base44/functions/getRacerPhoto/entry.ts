import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// BOAT WORKS 選手写真プロキシ
// ブラウザからboatrace.jpへ直接画像アクセスさせず、バックエンドで公式写真を取得してdata URLで返す。
// Web/PWA/モバイルで同じ経路を使うため、外部画像の参照制限差を回避する。

// 公式プロフィールHTMLが現在参照している写真パス。
// /owpc/pc/racer/{reg}/portrait.jpg はHTMLを返すため使用しない。
const PHOTO_BASE = 'https://www.boatrace.jp/racerphoto';

function toBase64(bytes: Uint8Array) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export default async function(req) {
  try {
    createClientFromRequest(req); // app context initialization; public read is allowed
    const body = await req.json().catch(() => ({}));
    const reg = String(body.registration_number || body.registrationNumber || '').trim();
    if (!/^\d{4}$/.test(reg)) {
      return Response.json({ status: 'error', message: 'registration_number は4桁の数字が必要です' }, { status: 400 });
    }

    const url = `${PHOTO_BASE}/${reg}.jpg`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.boatrace.jp/',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return Response.json({ status: 'not_found', registration_number: reg, message: `写真取得失敗 HTTP ${res.status}` }, { status: 404 });
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return Response.json({ status: 'not_found', registration_number: reg, message: '画像データではありません' }, { status: 404 });
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100) {
      return Response.json({ status: 'not_found', registration_number: reg, message: '画像データが空です' }, { status: 404 });
    }

    return Response.json({
      status: 'success',
      registration_number: reg,
      content_type: contentType,
      data_url: `data:${contentType};base64,${toBase64(bytes)}`,
    }, {
      headers: { 'Cache-Control': 'public, max-age=86400' }
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error?.message || '写真取得失敗' }, { status: 500 });
  }
}
