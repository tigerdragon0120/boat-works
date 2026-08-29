// 締切5分前の表示状態を監視する。
// final取得・分析はバックエンド Final Judge Worker に一本化し、画面から公式サイトへ重複アクセスしない。
import { useState, useEffect, useRef } from "react";
import { minutesUntilDeadline } from "@/lib/boat";

export function useFinalAutoJudge(races, analyses, onAnalysisUpdated, enabled = true) {
  const [statusMap, setStatusMap] = useState({});
  const racesRef = useRef(races);
  const analysesRef = useRef(analyses);
  const onUpdatedRef = useRef(onAnalysisUpdated);

  racesRef.current = races;
  analysesRef.current = analyses;
  onUpdatedRef.current = onAnalysisUpdated;

  useEffect(() => {
    if (!enabled) return;

    const check = () => {
      for (const race of racesRef.current) {
        const mins = minutesUntilDeadline(race.deadline);
        if (mins == null || mins > 5 || mins <= 0) continue;

        const raceId = race.id;
        // finalレコードが存在してもPENDINGなら未確定。最新オッズ取得＋final分析を続行する。
        const currentFinal = analysesRef.current[raceId];
        if (currentFinal?.stage === "final" && currentFinal?.judgment && currentFinal.judgment !== "PENDING") continue;
        setStatusMap(prev => prev[raceId]?.status === "waiting"
          ? prev
          : ({ ...prev, [raceId]: { status: "waiting" } }));
      }
    };

    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, [enabled]);

  return statusMap;
}