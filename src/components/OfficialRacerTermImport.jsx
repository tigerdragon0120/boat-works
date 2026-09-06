import React, { useState, useRef, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Upload, Users, CheckCircle2, AlertTriangle, XCircle,
  Loader2, FileText, Play, X, SkipForward, RotateCcw,
} from "lucide-react";

const STATUS_CONFIG = {
  pending:     { label: "待機中",   color: "bg-gray-100 text-gray-600",     icon: FileText },
  uploading:   { label: "アップロード中", color: "bg-blue-100 text-blue-700",  icon: Loader2 },
  previewing:  { label: "解析中",   color: "bg-blue-100 text-blue-700",       icon: Loader2 },
  previewed:   { label: "解析済",   color: "bg-amber-100 text-amber-700",    icon: CheckCircle2 },
  committing:  { label: "取込中",   color: "bg-blue-100 text-blue-700",       icon: Loader2 },
  done:        { label: "完了",     color: "bg-green-100 text-green-700",    icon: CheckCircle2 },
  error:       { label: "エラー",   color: "bg-red-100 text-red-700",        icon: XCircle },
  retrying:    { label: "再試行中", color: "bg-blue-100 text-blue-700",        icon: Loader2 },
  skipped:     { label: "取込済",   color: "bg-amber-100 text-amber-700",    icon: SkipForward },
};

let fileCounter = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientError = (error) => {
  const message = String(error?.response?.data?.message || error?.message || "").toLowerCase();
  const status = error?.response?.status;
  return !status || status === 408 || status === 429 || status >= 500 ||
    /network|connection lost|timeout|timed out|fetch|temporar/.test(message);
};

const withRetry = async (operation, onRetry, maxAttempts = 3) => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === maxAttempts) throw error;
      onRetry?.(attempt, maxAttempts);
      await sleep(1200 * attempt);
    }
  }
  throw lastError;
};

export default function OfficialRacerTermImport({ onCommitDone }) {
  const [fileQueue, setFileQueue] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const fileInputRef = useRef(null);

  const updateFile = useCallback((id, updates) => {
    setFileQueue((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  }, []);

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    const newFiles = files.map((file) => ({
      id: `rt_${++fileCounter}`,
      file,
      status: "pending",
      file_url: null,
      preview: null,
      commit_result: null,
      error: null,
    }));
    setFileQueue((prev) => [...prev, ...newFiles]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (id) => {
    setFileQueue((prev) => prev.filter((f) => f.id !== id));
  };

  const previewAll = async () => {
    const pending = fileQueue.filter((f) => f.status === "pending");
    if (pending.length === 0) return;
    setIsProcessing(true);
    setProgress({ current: 0, total: pending.length, label: "解析中" });

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      setProgress({ current: i + 1, total: pending.length, label: `解析: ${item.file.name}` });
      try {
        updateFile(item.id, { status: "uploading" });
        const uploadResult = await withRetry(
          () => base44.integrations.Core.UploadFile({ file: item.file }),
          (attempt, max) => updateFile(item.id, {
            status: "retrying",
            error: `通信を再試行しています（${attempt}/${max - 1}）`,
          })
        );
        const file_url = uploadResult.file_url;

        updateFile(item.id, { status: "previewing", file_url });
        const res = await withRetry(
          () => base44.functions.invoke("previewOfficialRacerTermV2", {
            file_url,
            file_name: item.file.name,
          }),
          (attempt, max) => updateFile(item.id, {
            status: "retrying",
            error: `解析通信を再試行しています（${attempt}/${max - 1}）`,
          })
        );
        const preview = res.data;

        if (preview.already_imported) {
          updateFile(item.id, { status: "skipped", preview, error: null });
        } else if (preview.is_importable) {
          updateFile(item.id, { status: "previewed", preview, error: null });
        } else {
          updateFile(item.id, { status: "error", preview, error: "検証エラーのため取込不可" });
        }
      } catch (e) {
        const errMsg = e?.response?.data?.message || e?.message || "解析に失敗しました";
        updateFile(item.id, { status: "error", error: errMsg });
      }
    }

    setIsProcessing(false);
    setProgress({ current: 0, total: 0, label: "" });
  };

  const commitFile = async (item) => {
    if (!item.file_url || !item.preview?.checksum) return;
    updateFile(item.id, { status: "committing" });
    try {
      const res = await withRetry(
        () => base44.functions.invoke("commitOfficialRacerTermV2", {
          file_url: item.file_url,
          file_name: item.file.name,
          expected_checksum: item.preview.checksum,
        }),
        (attempt, max) => updateFile(item.id, {
          status: "retrying",
          error: `取込通信を再試行しています（${attempt}/${max - 1}）`,
        })
      );
      const result = res.data;
      if (result.status === "success") {
        updateFile(item.id, { status: "done", commit_result: result, error: null });
        if (onCommitDone) onCommitDone(result.term_code);
      } else if (result.status === "already_imported") {
        updateFile(item.id, { status: "skipped", commit_result: result, error: null });
      } else {
        updateFile(item.id, { status: "error", commit_result: result, error: result.message || "取込に失敗しました" });
      }
    } catch (e) {
      const errMsg = e?.response?.data?.message || e?.message || "取込に失敗しました";
      updateFile(item.id, { status: "error", error: errMsg });
    }
  };

  const retryFile = async (item) => {
    setIsProcessing(true);
    updateFile(item.id, { status: "retrying", error: null });
    try {
      if (item.file_url && item.preview?.checksum && item.preview?.is_importable) {
        await commitFile(item);
        return;
      }

      updateFile(item.id, { status: "uploading" });
      const uploadResult = await withRetry(
        () => base44.integrations.Core.UploadFile({ file: item.file }),
        (attempt, max) => updateFile(item.id, {
          status: "retrying",
          error: `通信を再試行しています（${attempt}/${max - 1}）`,
        })
      );
      const file_url = uploadResult.file_url;
      updateFile(item.id, { status: "previewing", file_url, error: null });

      const res = await withRetry(
        () => base44.functions.invoke("previewOfficialRacerTermV2", {
          file_url,
          file_name: item.file.name,
        }),
        (attempt, max) => updateFile(item.id, {
          status: "retrying",
          error: `解析通信を再試行しています（${attempt}/${max - 1}）`,
        })
      );
      const preview = res.data;
      if (preview.already_imported) {
        updateFile(item.id, { status: "skipped", preview, error: null });
      } else if (preview.is_importable) {
        updateFile(item.id, { status: "previewed", preview, error: null });
      } else {
        updateFile(item.id, { status: "error", preview, error: "検証エラーのため取込不可" });
      }
    } catch (e) {
      const errMsg = e?.response?.data?.message || e?.message || "再試行に失敗しました";
      updateFile(item.id, { status: "error", error: errMsg });
    } finally {
      setIsProcessing(false);
    }
  };

  const commitAll = async () => {
    const ready = fileQueue.filter((f) => f.status === "previewed");
    if (ready.length === 0) return;
    setIsProcessing(true);
    setProgress({ current: 0, total: ready.length, label: "取込中" });

    for (let i = 0; i < ready.length; i++) {
      const item = ready[i];
      setProgress({ current: i + 1, total: ready.length, label: `取込: ${item.file.name}` });
      await commitFile(item);
    }

    setIsProcessing(false);
    setProgress({ current: 0, total: 0, label: "" });
  };

  const stats = {
    total: fileQueue.length,
    done: fileQueue.filter((f) => f.status === "done").length,
    error: fileQueue.filter((f) => f.status === "error").length,
    skipped: fileQueue.filter((f) => f.status === "skipped").length,
    previewed: fileQueue.filter((f) => f.status === "previewed").length,
    pending: fileQueue.filter((f) => f.status === "pending").length,
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="w-4 h-4" />ファイル選択（複数選択可）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="racer-term-file">選手期別成績TXTファイル（Shift-JIS / 公式サイトから解凍したもの）</Label>
            <Input
              id="racer-term-file"
              ref={fileInputRef}
              type="file"
              accept=".txt,.TXT"
              multiple
              onChange={handleFileSelect}
              className="mt-1"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button onClick={previewAll} disabled={isProcessing || stats.pending === 0} size="sm">
              {isProcessing && progress.label.includes("解析") ? (
                <><Loader2 className="w-4 h-4 mr-1 animate-spin" />解析中...</>
              ) : (
                <><Play className="w-4 h-4 mr-1" />全ファイル解析</>
              )}
            </Button>
            <Button onClick={commitAll} disabled={isProcessing || stats.previewed === 0} size="sm" variant="secondary">
              {isProcessing && progress.label.includes("取込") ? (
                <><Loader2 className="w-4 h-4 mr-1 animate-spin" />取込中...</>
              ) : (
                <><CheckCircle2 className="w-4 h-4 mr-1" />全ファイル取込</>
              )}
            </Button>
          </div>
          {isProcessing && progress.total > 0 && (
            <div className="text-sm text-muted-foreground">
              {progress.label} ({progress.current}/{progress.total})
            </div>
          )}
          {stats.total > 0 && (
            <div className="flex gap-2 flex-wrap text-xs">
              <Badge variant="secondary">合計:{stats.total}</Badge>
              <Badge className="bg-amber-100 text-amber-700">解析済:{stats.previewed}</Badge>
              <Badge className="bg-green-100 text-green-700">完了:{stats.done}</Badge>
              <Badge className="bg-red-100 text-red-700">エラー:{stats.error}</Badge>
              <Badge className="bg-gray-100 text-gray-600">スキップ:{stats.skipped}</Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {fileQueue.length > 0 && (
        <div className="space-y-2">
          {fileQueue.map((item) => {
            const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.pending;
            const Icon = cfg.icon;
            const spin = item.status === "uploading" || item.status === "previewing" || item.status === "committing" || item.status === "retrying";
            return (
              <Card key={item.id} className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Icon className={`w-4 h-4 ${spin ? "animate-spin" : ""}`} />
                      <span className="text-sm font-medium truncate">{item.file.name}</span>
                      <Badge className={cfg.color} variant="outline">{cfg.label}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      ({(item.file.size / 1024).toFixed(1)} KB)
                    </div>

                    {/* プレビュー結果 */}
                    {item.preview && (
                      <div className="mt-2 space-y-1">
                        <div className="flex gap-2 flex-wrap text-xs">
                          {item.preview.term_label && (
                            <Badge variant="secondary">{item.preview.term_label}</Badge>
                          )}
                          {item.preview.term_code && (
                            <Badge variant="outline">期:{item.preview.term_code}</Badge>
                          )}
                          <span>選手:{item.preview.racer_count}</span>
                          <span>行:{item.preview.line_count}</span>
                          {item.preview.error_count > 0 && (
                            <span className="text-red-600">エラー:{item.preview.error_count}</span>
                          )}
                          {item.preview.warning_count > 0 && (
                            <span className="text-amber-600">警告:{item.preview.warning_count}</span>
                          )}
                          {item.preview.has_mojibake && (
                            <span className="text-red-600">文字化け</span>
                          )}
                        </div>
                        {item.preview.errors?.length > 0 && (
                          <div className="max-h-32 overflow-y-auto space-y-0.5">
                            {item.preview.errors.slice(0, 10).map((e, i) => (
                              <div key={i} className="text-xs bg-red-50 border border-red-200 rounded px-2 py-0.5">
                                {e.line ? `L${e.line}: ` : ""}{e.message}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 取込結果 */}
                    {item.commit_result && (
                      <div className="mt-2 flex gap-2 flex-wrap text-xs">
                        {item.commit_result.term_label && (
                          <Badge variant="secondary">{item.commit_result.term_label}</Badge>
                        )}
                        <span className="text-green-600">新規:{item.commit_result.inserted_count}</span>
                        <span className="text-blue-600">更新:{item.commit_result.updated_count}</span>
                        <span className="text-gray-500">変更なし:{item.commit_result.unchanged_count}</span>
                        {item.commit_result.error_count > 0 && (
                          <span className="text-red-600">エラー:{item.commit_result.error_count}</span>
                        )}
                      </div>
                    )}

                    {/* エラー */}
                    {item.error && (
                      <div className="mt-1 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
                        {item.error}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    {item.status === "previewed" && (
                      <Button size="sm" onClick={() => commitFile(item)} disabled={isProcessing}>
                        取込
                      </Button>
                    )}
                    {item.status === "error" && (
                      <Button size="sm" variant="outline" onClick={() => retryFile(item)} disabled={isProcessing}>
                        <RotateCcw className="w-3 h-3 mr-1" />再試行
                      </Button>
                    )}
                    {(item.status === "pending" || item.status === "error" || item.status === "done" || item.status === "skipped") && (
                      <Button size="sm" variant="ghost" onClick={() => removeFile(item.id)} disabled={isProcessing}>
                        <X className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}