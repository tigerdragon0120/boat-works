import React, { useState, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Upload, FileText, CheckCircle2, AlertTriangle, XCircle,
  Loader2, Database, Search,
} from "lucide-react";

const STATUS_COLORS = {
  COMPLETED: "bg-green-100 text-green-700 border-green-300",
  FAILED: "bg-red-100 text-red-700 border-red-300",
  IMPORTING: "bg-blue-100 text-blue-700 border-blue-300",
  PREVIEWED: "bg-amber-100 text-amber-700 border-amber-300",
  UPLOADED: "bg-gray-100 text-gray-700 border-gray-300",
};

function StatBox({ label, value, color }) {
  return (
    <div className={`rounded-lg border p-3 text-center ${color || "bg-blue-50 border-blue-200"}`}>
      <div className="text-2xl font-bold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function ErrorList({ items, title, icon: Icon, color }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3">
      <div className={`flex items-center gap-2 text-sm font-semibold ${color}`}>
        <Icon className="w-4 h-4" />
        {title} ({items.length})
      </div>
      <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
        {items.slice(0, 50).map((e, i) => (
          <div key={i} className="text-xs bg-red-50 border border-red-200 rounded px-2 py-1">
            {e.line ? `L${e.line}: ` : ""}{e.message || JSON.stringify(e)}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OfficialKImport({ onCommitDone }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileUrl, setFileUrl] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitResult, setCommitResult] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileSelect = (e) => {
    const f = e.target.files?.[0];
    if (f) {
      setSelectedFile(f);
      setPreview(null);
      setPreviewError(null);
      setCommitResult(null);
      setFileUrl(null);
      setShowConfirm(false);
    }
  };

  const handlePreview = async () => {
    if (!selectedFile) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    setCommitResult(null);
    try {
      const uploadResult = await base44.integrations.Core.UploadFile({ file: selectedFile });
      const url = uploadResult.file_url;
      setFileUrl(url);
      const res = await base44.functions.invoke("previewOfficialProgramKV2", {
        file_url: url,
        file_name: selectedFile.name,
      });
      setPreview(res.data);
    } catch (e) {
      const errMsg = e?.response?.data?.message || e?.message || "プレビューに失敗しました";
      setPreviewError(errMsg);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!fileUrl || !selectedFile || !preview?.checksum) return;
    setShowConfirm(false);
    setCommitLoading(true);
    setCommitResult(null);
    try {
      const res = await base44.functions.invoke("commitOfficialProgramKV2", {
        file_url: fileUrl,
        file_name: selectedFile.name,
        expected_checksum: preview.checksum,
      });
      setCommitResult(res.data);
      if (onCommitDone) onCommitDone(res.data?.source_date);
    } catch (e) {
      const errData = e?.response?.data;
      setCommitResult({ status: "error", message: errData?.message || e?.message || "取込に失敗しました", errors: errData?.errors || [] });
    } finally {
      setCommitLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="w-4 h-4" />Kファイル選択
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="k-file-input">競走成績Kファイル（TXT / Shift-JIS）</Label>
            <Input
              id="k-file-input"
              ref={fileInputRef}
              type="file"
              accept=".txt,.TXT"
              onChange={handleFileSelect}
              className="mt-1"
            />
          </div>
          {selectedFile && (
            <div className="text-sm text-muted-foreground">
              選択中: <span className="font-medium text-foreground">{selectedFile.name}</span>
              {" "}({(selectedFile.size / 1024).toFixed(1)} KB)
            </div>
          )}
          <Button
            onClick={handlePreview}
            disabled={!selectedFile || previewLoading}
            className="w-full"
          >
            {previewLoading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />解析中...</>
            ) : (
              <><Search className="w-4 h-4 mr-2" />解析・プレビュー</>
            )}
          </Button>
          {previewError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
              {previewError}
            </div>
          )}
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="w-4 h-4" />プレビュー結果
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-4 gap-2">
              <StatBox label="会場数" value={preview.venue_count} />
              <StatBox label="レース数" value={preview.race_count} color="bg-emerald-50 border-emerald-200" />
              <StatBox label="選手結果" value={preview.entry_result_count} color="bg-cyan-50 border-cyan-200" />
              <StatBox label="払戻件数" value={preview.payout_count} color="bg-amber-50 border-amber-200" />
            </div>
            <div className="text-xs space-y-1 text-muted-foreground">
              <div>開催日: <span className="font-medium text-foreground">{preview.source_date || "—"}</span></div>
              <div>ファイル: {preview.file_name}</div>
              <div className="truncate">checksum: {preview.checksum?.substring(0, 24)}...</div>
              <div>encoding: {preview.encoding} / {preview.byte_size} bytes</div>
              <div>B番組表照合: 一致{preview.b_match_count} / 不一致{preview.b_mismatch_count}</div>
              {preview.entry_mismatch_count > 0 && (
                <div className="text-red-600">選手照合不一致: {preview.entry_mismatch_count}件</div>
              )}
              {preview.b_missing_entry_count > 0 && (
                <div className="text-red-600">K選手結果欠落: {preview.b_missing_entry_count}件</div>
              )}
              {preview.unparsed_line_count > 0 && (
                <div className="text-amber-600">未解析行: {preview.unparsed_line_count}件</div>
              )}
            </div>

            {preview.already_imported && (
              <div className="flex items-center gap-2 text-sm bg-amber-50 border border-amber-200 rounded p-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                このファイルは既に取込済みです（batch: {preview.existing_batch_key}）
              </div>
            )}

            {preview.is_importable && !preview.already_imported && (
              <div className="flex items-center gap-2 text-sm bg-green-50 border border-green-200 rounded p-2">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                検証OK — 取込可能です
              </div>
            )}

            {preview.venues?.length > 0 && (
              <div>
                <div className="text-sm font-semibold mb-2">会場別レース数</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {preview.venues.map((v) => (
                    <div key={v.venue_code} className="flex items-center justify-between text-xs bg-muted rounded px-2 py-1">
                      <span>{v.venue_code} {v.venue_name}</span>
                      <Badge variant="secondary" className="ml-1">{v.race_count}R</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <ErrorList items={preview.errors} title="重大エラー" icon={XCircle} color="text-red-600" />
            <ErrorList items={preview.warnings} title="警告" icon={AlertTriangle} color="text-amber-600" />

            {preview.is_importable && !preview.already_imported && !showConfirm && (
              <Button
                onClick={() => setShowConfirm(true)}
                disabled={commitLoading}
                className="w-full"
                size="lg"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />確定取込へ進む
              </Button>
            )}

            {showConfirm && (
              <div className="border border-blue-300 bg-blue-50 rounded-lg p-4 space-y-3">
                <div className="font-semibold text-sm">取込確認</div>
                <div className="text-sm text-muted-foreground">
                  このファイルから <strong>{preview.venue_count}</strong>会場・
                  <strong>{preview.race_count}</strong>レース・
                  <strong>{preview.entry_result_count}</strong>選手結果・
                  <strong>{preview.payout_count}</strong>払戻を取り込みます。
                  <br />既存のV2データはresult_key/entry_result_key/payout_keyで照合され、重複作成されません。
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleCommit} disabled={commitLoading} className="flex-1">
                    {commitLoading ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" />取込中...</>
                    ) : (
                      <><CheckCircle2 className="w-4 h-4 mr-2" />確定取込</>
                    )}
                  </Button>
                  <Button variant="outline" onClick={() => setShowConfirm(false)} disabled={commitLoading}>
                    キャンセル
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {commitResult && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              {commitResult.status === "success" ? (
                <><CheckCircle2 className="w-4 h-4 text-green-600" />取込完了</>
              ) : commitResult.status === "already_imported" ? (
                <><AlertTriangle className="w-4 h-4 text-amber-600" />取込済み</>
              ) : (
                <><XCircle className="w-4 h-4 text-red-600" />取込結果</>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {commitResult.message && (
              <div className="text-sm">{commitResult.message}</div>
            )}
            {commitResult.batch_key && (
              <div className="text-xs text-muted-foreground">
                batch: {commitResult.batch_key}
              </div>
            )}
            {(commitResult.created_count != null) && (
              <div className="grid grid-cols-4 gap-2">
                <StatBox label="作成" value={commitResult.created_count} color="bg-green-50 border-green-200" />
                <StatBox label="更新" value={commitResult.updated_count} color="bg-blue-50 border-blue-200" />
                <StatBox label="変更なし" value={commitResult.unchanged_count} color="bg-gray-50 border-gray-200" />
                <StatBox label="エラー" value={commitResult.error_count} color="bg-red-50 border-red-200" />
              </div>
            )}
            <ErrorList items={commitResult.errors} title="エラー" icon={XCircle} color="text-red-600" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}