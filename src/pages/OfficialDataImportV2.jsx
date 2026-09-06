import React, { useState, useRef, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Upload, FileText, CheckCircle2, AlertTriangle, XCircle,
  Loader2, Database, ShieldCheck, History, Search,
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

export default function OfficialDataImportV2() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileUrl, setFileUrl] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitResult, setCommitResult] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [auditDate, setAuditDate] = useState(new Date().toISOString().slice(0, 10));
  const [auditResult, setAuditResult] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [batches, setBatches] = useState([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const fileInputRef = useRef(null);

  const loadBatches = useCallback(async () => {
    setBatchesLoading(true);
    try {
      const result = await base44.entities.OfficialImportBatchV2.list("-created_date", 20);
      setBatches(result || []);
    } catch {
      setBatches([]);
    } finally {
      setBatchesLoading(false);
    }
  }, []);

  useEffect(() => { loadBatches(); }, [loadBatches]);

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
      const res = await base44.functions.invoke("previewOfficialProgramBV2", {
        file_url: url,
        file_name: selectedFile.name,
      });
      setPreview(res.data);
    } catch (e) {
      setPreviewError(e?.message || "プレビューに失敗しました");
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
      const res = await base44.functions.invoke("commitOfficialProgramBV2", {
        file_url: fileUrl,
        file_name: selectedFile.name,
        expected_checksum: preview.checksum,
      });
      setCommitResult(res.data);
      if (res.data?.source_date) {
        setAuditDate(res.data.source_date);
        runAudit(res.data.source_date);
      }
      loadBatches();
    } catch (e) {
      setCommitResult({ status: "error", message: e?.message || "取込に失敗しました" });
    } finally {
      setCommitLoading(false);
    }
  };

  const runAudit = async (date) => {
    const targetDate = date || auditDate;
    if (!targetDate) return;
    setAuditLoading(true);
    try {
      const res = await base44.functions.invoke("auditOfficialProgramDayV2", { race_date: targetDate });
      setAuditResult(res.data);
    } catch (e) {
      setAuditResult({ status: "error", message: e?.message || "監査に失敗しました" });
    } finally {
      setAuditLoading(false);
    }
  };

  const canCommit = preview?.is_importable && !preview?.already_imported && !commitLoading;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-6 h-6 text-primary" />
        <div>
          <h1 className="text-xl font-bold">公式データ取込V2</h1>
          <p className="text-xs text-muted-foreground">公式番組表Bファイルの安全な取込（第1段階）</p>
        </div>
      </div>

      <Tabs defaultValue="program-b">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="program-b" className="text-xs sm:text-sm">
            <FileText className="w-4 h-4 mr-1" />番組表B
          </TabsTrigger>
          <TabsTrigger value="audit" className="text-xs sm:text-sm">
            <Search className="w-4 h-4 mr-1" />監査
          </TabsTrigger>
          <TabsTrigger value="history" className="text-xs sm:text-sm">
            <History className="w-4 h-4 mr-1" />履歴
          </TabsTrigger>
        </TabsList>

        {/* ─── 番組表Bファイル タブ ─── */}
        <TabsContent value="program-b" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Upload className="w-4 h-4" />ファイル選択
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label htmlFor="file-input">番組表Bファイル（TXT / Shift-JIS）</Label>
                <Input
                  id="file-input"
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
                <div className="grid grid-cols-3 gap-2">
                  <StatBox label="会場数" value={preview.venue_count} />
                  <StatBox label="レース数" value={preview.race_count} color="bg-emerald-50 border-emerald-200" />
                  <StatBox label="選手行数" value={preview.entry_count} color="bg-cyan-50 border-cyan-200" />
                </div>
                <div className="text-xs space-y-1 text-muted-foreground">
                  <div>開催日: <span className="font-medium text-foreground">{preview.source_date || "—"}</span></div>
                  <div>ファイル: {preview.file_name}</div>
                  <div className="truncate">checksum: {preview.checksum?.substring(0, 24)}...</div>
                  <div>encoding: {preview.encoding} / {preview.byte_size} bytes</div>
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

                {/* 会場別件数 */}
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

                {/* 確定取込ボタン */}
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

                {/* 確認ダイアログ */}
                {showConfirm && (
                  <div className="border border-blue-300 bg-blue-50 rounded-lg p-4 space-y-3">
                    <div className="font-semibold text-sm">取込確認</div>
                    <div className="text-sm text-muted-foreground">
                      このファイルから <strong>{preview.venue_count}</strong>会場・
                      <strong>{preview.race_count}</strong>レース・
                      <strong>{preview.entry_count}</strong>選手を取り込みます。
                      <br />既存のV2データはrace_keyとentry_keyで照合され、重複作成されません。
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
        </TabsContent>

        {/* ─── 監査タブ ─── */}
        <TabsContent value="audit" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Search className="w-4 h-4" />日次監査
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label htmlFor="audit-date">対象日</Label>
                  <Input
                    id="audit-date"
                    type="date"
                    value={auditDate}
                    onChange={(e) => setAuditDate(e.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <Button onClick={() => runAudit()} disabled={auditLoading}>
                    {auditLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4 mr-1" />}
                    監査実行
                  </Button>
                </div>
              </div>

              {auditResult && auditResult.status !== "error" && (
                <>
                  <div className="flex items-center gap-2">
                    <Badge className={
                      auditResult.overall === "PASS" ? "bg-green-100 text-green-700" :
                      auditResult.overall === "EMPTY" ? "bg-gray-100 text-gray-700" :
                      "bg-red-100 text-red-700"
                    }>
                      {auditResult.overall}
                    </Badge>
                    {auditResult.last_completed_batch_key && (
                      <span className="text-xs text-muted-foreground">
                        最終batch: {auditResult.last_completed_batch_key}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <StatBox label="会場数" value={auditResult.venue_count} />
                    <StatBox label="レース数" value={auditResult.race_count} color="bg-emerald-50 border-emerald-200" />
                    <StatBox label="選手行数" value={auditResult.entry_count} color="bg-cyan-50 border-cyan-200" />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                    <div className={`rounded p-2 ${auditResult.race_key_duplicates?.length === 0 ? "bg-green-50" : "bg-red-50"}`}>
                      race_key重複: {auditResult.race_key_duplicates?.length || 0}
                    </div>
                    <div className={`rounded p-2 ${auditResult.entry_key_duplicates?.length === 0 ? "bg-green-50" : "bg-red-50"}`}>
                      entry_key重複: {auditResult.entry_key_duplicates?.length || 0}
                    </div>
                    <div className={`rounded p-2 ${auditResult.missing_venue_code === 0 ? "bg-green-50" : "bg-red-50"}`}>
                      場コード欠落: {auditResult.missing_venue_code}
                    </div>
                    <div className={`rounded p-2 ${auditResult.missing_race_number === 0 ? "bg-green-50" : "bg-red-50"}`}>
                      R番号欠落: {auditResult.missing_race_number}
                    </div>
                    <div className={`rounded p-2 ${auditResult.missing_boat_number === 0 ? "bg-green-50" : "bg-red-50"}`}>
                      艇番欠落: {auditResult.missing_boat_number}
                    </div>
                    <div className={`rounded p-2 ${auditResult.missing_registration_number === 0 ? "bg-green-50" : "bg-red-50"}`}>
                      登録番号欠落: {auditResult.missing_registration_number}
                    </div>
                    <div className={`rounded p-2 ${auditResult.orphan_entries === 0 ? "bg-green-50" : "bg-red-50"}`}>
                      孤立Entry: {auditResult.orphan_entries}
                    </div>
                  </div>
                  {auditResult.venues?.length > 0 && (
                    <div>
                      <div className="text-sm font-semibold mb-2">会場別件数</div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                        {auditResult.venues.map((v) => (
                          <div key={v.venue_code} className="flex items-center justify-between text-xs bg-muted rounded px-2 py-1">
                            <span>{v.venue_code} {v.venue_name}</span>
                            <Badge variant="secondary" className="ml-1">{v.race_count}R / {v.entry_count}人</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              {auditResult?.status === "error" && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
                  {auditResult.message}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── 履歴タブ ─── */}
        <TabsContent value="history" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <History className="w-4 h-4" />取込履歴
              </CardTitle>
            </CardHeader>
            <CardContent>
              {batchesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : batches.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground py-8">取込履歴がありません</div>
              ) : (
                <div className="space-y-2">
                  {batches.map((b) => (
                    <div key={b.id} className="border rounded-lg p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{b.source_date || "—"}</span>
                        <Badge className={STATUS_COLORS[b.status] || "bg-gray-100"} variant="outline">
                          {b.status}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{b.file_name}</div>
                      <div className="flex flex-wrap gap-2 text-xs">
                        <span>会場:{b.venue_count}</span>
                        <span>レース:{b.race_count}</span>
                        <span>選手:{b.entry_count}</span>
                        <span className="text-green-600">作成:{b.created_count}</span>
                        <span className="text-blue-600">更新:{b.updated_count}</span>
                        <span className="text-gray-500">変更なし:{b.unchanged_count}</span>
                        {b.error_count > 0 && <span className="text-red-600">エラー:{b.error_count}</span>}
                      </div>
                      {b.is_publishable && (
                        <Badge className="bg-green-100 text-green-700 text-xs">publishable</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}