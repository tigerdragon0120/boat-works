// 締切5分前になったレースだけ最新オッズ取得＋final分析を自動実行
// in-flight管理・1回リトライ(90s後)・既存finalは再取得しない
import { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { fetchOfficialRace } from "@/lib/boatService";
import { analyzeRaceFinal, getCachedAnalysesForRace } from "@/lib/analysisCache";
import { minutesUntilDeadline } from "@/lib/boat";

const RETRY_DELAY_MS = 90000;

export function useFinalAutoJudge(races, analyses, onAnalysisUpdated, enabled = true) {
  const [statusMap, setStatusMap] = useState({});
  const inFlightRef = useRef(new Set());
  const failedRef = useRef(new Map());
  const racesRef = useRef(races);
  const analysesRef = useRef(analyses);
  const onUpdatedRef = useRef(onAnalysisUpdated);

  racesRef.current = races;
  analysesRef.current = analyses;
  onUpdatedRef.current = onAnalysisUpdated;

  useEffect(() => {
    if (!enabled) return;

    const triggerFinal = async (race) => {
      const raceId = race.id;
      inFlightRef.current.add(raceId);
      setStatusMap(prev => ({ ...prev, [raceId]: { status: "fetching" } }));

      try {
        // 1. 最新オッズ取得（出走表+オッズ）
        const res = await fetchOfficialRace(race.race_date, race.venue_code, race.race_number);
        if (res?.status !== "success") throw new Error(res?.message || "odds fetch failed");

        // 2. final分析（単レース・stage="final"）
        await analyzeRaceFinal(raceId, race.race_date);

        // 3. キャッシュから再読込
        const byStage = await getCachedAnalysesForRace(raceId);
        if (byStage.final) {
          onUpdatedRef.current(raceId, byStage.final);
          // BUY/WATCH判定時にプッシュ通知送信（失敗は非クリティカル）
          // 通知条件のフィルタリングは notifyBuyAlert 側で AppSettings を参照して行う
          if (byStage.final.judgment === "BUY" || byStage.final.judgment === "WATCH") {
            try {
              await base44.functions.invoke("notifyBuyAlert", {
                race_id: raceId,
                deadline: race.deadline,
              });
            } catch (e) { /* 通知失敗は無視 */ }
          }
        }
        setStatusMap(prev => ({ ...prev, [raceId]: { status: "done" } }));
        failedRef.current.delete(raceId);
      } catch (e) {
        const wasRetried = failedRef.current.get(raceId)?.retried;
        failedRef.current.set(raceId, { time: Date.now(), retried: true });
        setStatusMap(prev => ({ ...prev, [raceId]: { status: "failed", canRetry: !wasRetried } }));
      } finally {
        inFlightRef.current.delete(raceId);
      }
    };

    const check = () => {
      const now = Date.now();
      for (const race of racesRef.current) {
        const mins = minutesUntilDeadline(race.deadline);
        if (mins == null || mins > 5 || mins <= 0) continue;

        const raceId = race.id;
        // finalレコードが存在してもPENDINGなら未確定。最新オッズ取得＋final分析を続行する。
        const currentFinal = analysesRef.current[raceId];
        if (currentFinal?.stage === "final" && currentFinal?.judgment && currentFinal.judgment !== "PENDING") continue;
        if (inFlightRef.current.has(raceId)) continue;

        const failed = failedRef.current.get(raceId);
        if (failed) {
          if (failed.retried) continue;
          if (now - failed.time < RETRY_DELAY_MS) continue;
        }

        triggerFinal(race);
      }
    };

    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, [enabled]);

  return statusMap;
}