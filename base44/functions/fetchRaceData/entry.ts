import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { VENUES, UICHI_COMBOS, isUichiHit, whichUichiCombo, gradeBoat1, syntheticOdds, expectedValue, judge, similarityScore } from "../../shared/uichi.js";

// BOAT WORKS データ取得関数
// 外部データ取得部分をUIから分離。公式サイトへのアクセスはここに集約。
// 現状は構造化スタブ（実際のスクレイピングは後から実装可能）。
// mode: "today" | "tomorrow" | "results" | "odds"
// 取得失敗時は架空データを作らずエラーを返す。

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const mode = body.mode || "today";
    const venueCode = body.venue_code;
    const raceId = body.race_id;

    // TODO: 実際の公式サイト取得処理に差し替え可能。
    // 現状は取得失敗を明示的に返す設計（架空データ不使用）。
    return Response.json({
      status: "error",
      mode,
      message: "データ取得失敗：外部データソース未接続。公式サイト連携を設定してください。",
      captured_at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}