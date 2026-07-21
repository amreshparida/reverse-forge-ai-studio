import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { api } from '../api/client';
import type { CrawlSession, GenerationProgress, Report } from '../types';

type LatestPreview = {
  content: string;
  path: string;
  report: Report;
  sessionId: string;
};

function formatDate(value?: string) {
  if (!value) return 'Not available';
  return new Date(value).toLocaleString();
}

function StatTile({ label, value, tone = 'blue' }: { label: string; value: string | number; tone?: 'blue' | 'green' | 'gray' }) {
  const toneClass = tone === 'green' ? 'text-emerald-700' : tone === 'gray' ? 'text-gray-700' : 'text-brand-700';
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

function ProgressBar({ value, tone = 'blue' }: { value: number; tone?: 'blue' | 'amber' | 'red' | 'green' }) {
  const bar =
    tone === 'amber' ? 'bg-amber-500' :
    tone === 'red' ? 'bg-red-500' :
    tone === 'green' ? 'bg-emerald-500' :
    'bg-brand-600';
  return (
    <div className="w-full bg-gray-200 rounded-full h-3">
      <div
        className={`${bar} h-3 rounded-full transition-all duration-300`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

function statusBadge(status: GenerationProgress['status']) {
  if (status === 'running') return 'badge-blue';
  if (status === 'paused') return 'badge-yellow';
  if (status === 'failed') return 'badge-red';
  if (status === 'completed') return 'badge-green';
  return 'badge-gray';
}

function progressTone(status: GenerationProgress['status']): 'blue' | 'amber' | 'red' | 'green' {
  if (status === 'paused') return 'amber';
  if (status === 'failed') return 'red';
  if (status === 'completed') return 'green';
  return 'blue';
}

export default function Reports() {
  const { projectId } = useParams<{ projectId: string }>();
  const [reports, setReports] = useState<Report[]>([]);
  const [sessions, setSessions] = useState<CrawlSession[]>([]);
  const [latest, setLatest] = useState<LatestPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GenerationProgress | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const completedSessions = useMemo(() => sessions.filter((session) => session.status === 'completed'), [sessions]);
  const latestReport = latest?.report ?? reports[0] ?? null;
  const totalPages = completedSessions.reduce((sum, session) => sum + (session.pagesCount ?? session._count?.pages ?? 0), 0);

  const isGenerating = generation?.status === 'running' || generation?.jobActive;
  const isPaused = generation?.status === 'paused' || (generation?.status === 'failed' && generation.canResume);
  const showProgressCard = Boolean(generation && generation.status !== 'idle');

  const loadGenerationStatus = useCallback(async () => {
    if (!projectId) return;
    try {
      const status = await api.getGenerationStatus(projectId);
      setGeneration(status);
    } catch {
      // ignore — older backends without this endpoint
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [reportData, crawlData] = await Promise.all([
        api.getReports(projectId),
        api.getCrawls(projectId),
      ]);
      setReports(reportData.reports);
      setSessions(crawlData.sessions);
      await loadGenerationStatus();
      if (reportData.reports.length > 0) {
        setPreviewLoading(true);
        try {
          setLatest(await api.getLatestReportPreview(projectId));
        } catch (err) {
          setLatest(null);
          setError(err instanceof Error ? err.message : 'Report preview is not available yet.');
        } finally {
          setPreviewLoading(false);
        }
      } else {
        setLatest(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports.');
    } finally {
      setLoading(false);
    }
  }, [projectId, loadGenerationStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live generation progress via SSE + light polling fallback
  useEffect(() => {
    if (!projectId) return;
    void loadGenerationStatus();

    const evtSource = new EventSource('/api/events');
    evtSource.addEventListener('generation', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as GenerationProgress;
      if (data.projectId && data.projectId !== projectId) return;
      setGeneration(data);
      if (data.status === 'completed') {
        void refresh();
      }
    });
    evtSource.addEventListener('job', (e) => {
      const job = JSON.parse((e as MessageEvent).data) as { id: string; status: string; progress: number };
      if (job.id !== `project-report-${projectId}` && !job.id.startsWith('report-')) return;
      if (job.status === 'completed') {
        void loadGenerationStatus();
        void refresh();
      } else if (job.status === 'failed') {
        void loadGenerationStatus();
      } else {
        setGeneration((prev) => prev ? {
          ...prev,
          status: 'running',
          progress: Math.max(prev.progress, job.progress),
          jobActive: job.status === 'active' || job.status === 'waiting',
        } : prev);
      }
    });

    const poll = setInterval(() => {
      void loadGenerationStatus();
    }, 5000);

    return () => {
      evtSource.close();
      clearInterval(poll);
    };
  }, [projectId, loadGenerationStatus, refresh]);

  const handleExtract = async () => {
    if (!projectId) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      const res = await api.generateProjectReport(projectId);
      setActionMsg(res.message);
      await loadGenerationStatus();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : 'Failed to start report generation');
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async () => {
    if (!projectId) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      const res = await api.resumeProjectReport(projectId);
      setActionMsg(res.message);
      await loadGenerationStatus();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : 'Failed to resume report generation');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-gray-500">
            <Link to={`/projects/${projectId}`} className="hover:text-gray-900">Back to Project</Link>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Project Report</h1>
          <p className="mt-1 text-sm text-gray-500">
            One report is extracted across every completed crawl session in this project.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => { void refresh(); }} className="btn-secondary" disabled={loading || previewLoading}>
            Refresh
          </button>
          {!isGenerating && !isPaused && (
            <button
              onClick={() => { void handleExtract(); }}
              className="btn-primary"
              disabled={actionLoading || completedSessions.length === 0}
              title={completedSessions.length === 0 ? 'Complete at least one crawl first' : 'Start report generation'}
            >
              {actionLoading ? 'Starting…' : 'Extract Report'}
            </button>
          )}
          {latestReport && projectId && (
            <>
              <a href={api.downloadReport(latestReport.id, projectId)} download className="btn-primary">
                Download PDF/MD
              </a>
              <a href={api.exportLatestReport(projectId)} download className="btn-secondary">
                Download Evidence ZIP
              </a>
            </>
          )}
        </div>
      </div>

      {actionMsg && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {actionMsg}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          {error}
        </div>
      )}

      {showProgressCard && generation && (
        <div className={`card border ${
          generation.status === 'paused' || generation.status === 'failed'
            ? 'border-amber-200 bg-amber-50'
            : generation.status === 'completed'
              ? 'border-emerald-200 bg-emerald-50'
              : 'border-brand-200 bg-brand-50'
        }`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold text-gray-900">
                  {generation.status === 'paused' ? 'Generation paused' :
                   generation.status === 'failed' ? 'Generation failed' :
                   generation.status === 'completed' ? 'Generation complete' :
                   'Generating report'}
                </h2>
                <span className={`badge ${statusBadge(generation.status)}`}>{generation.status}</span>
              </div>
              <p className="mt-1 text-sm text-gray-700">{generation.message}</p>
              {generation.stageLabel && generation.status !== 'completed' && (
                <p className="mt-1 text-xs text-gray-500">
                  Stage: {generation.stageLabel}
                  {generation.completedStages.length > 0
                    ? ` · ${generation.completedStages.length} stage(s) checkpointed`
                    : ''}
                </p>
              )}
              {generation.error && (
                <p className="mt-2 text-sm text-red-700">{generation.error}</p>
              )}
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
                  <span>{generation.stageLabel || 'Progress'}</span>
                  <span>{generation.progress.toFixed(0)}%</span>
                </div>
                <ProgressBar value={generation.progress} tone={progressTone(generation.status)} />
              </div>
            </div>
            {(generation.status === 'paused' || generation.status === 'failed') && generation.canResume && (
              <button
                onClick={() => { void handleResume(); }}
                disabled={actionLoading}
                className="btn-primary shrink-0"
              >
                {actionLoading ? 'Resuming…' : 'Resume'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Completed Sessions Used" value={completedSessions.length} tone="green" />
        <StatTile label="Pages Captured" value={totalPages} />
        <StatTile label="Generated Reports" value={reports.length} tone="gray" />
        <StatTile label="Latest Generated" value={latestReport ? formatDate(latestReport.createdAt) : 'None'} tone="gray" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {loading || previewLoading ? (
            <div className="card flex h-80 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-brand-600" />
            </div>
          ) : latest?.content ? (
            <div className="card max-h-[calc(100vh-220px)] overflow-auto">
              <div className="mb-4 border-b border-gray-200 pb-3">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Latest project report preview</div>
                <div className="mt-1 text-sm text-gray-600">{latest.path}</div>
              </div>
              <div className="prose prose-sm max-w-none">
                <ReactMarkdown>{latest.content}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="card flex min-h-80 flex-col items-center justify-center text-center">
              <div className="mb-3 text-4xl font-bold text-gray-300">REPORT</div>
              <h2 className="text-lg font-semibold text-gray-900">
                {isGenerating ? 'Report generation in progress' : 'No project report generated yet'}
              </h2>
              <p className="mt-2 max-w-md text-sm text-gray-500">
                {isGenerating
                  ? 'Progress updates above. You can leave this page and come back — checkpoints are saved.'
                  : isPaused
                    ? 'Generation was interrupted. Click Resume above to continue from the last checkpoint.'
                    : 'Run Extract Report after at least one crawl has completed.'}
              </p>
              {!isGenerating && !isPaused && (
                <Link to={`/projects/${projectId}`} className="btn-primary mt-5">
                  Go to Overview
                </Link>
              )}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="card">
            <h2 className="font-semibold text-gray-900">Report Scope</h2>
            <div className="mt-3 space-y-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="text-gray-500">Input model</span>
                <span className="text-right font-medium text-gray-900">All completed sessions</span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-gray-500">Raw evidence</span>
                <span className="text-right font-medium text-gray-900">Pages, APIs, files, graph</span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-gray-500">Checkpoints</span>
                <span className="text-right font-medium text-gray-900">Resume after crash</span>
              </div>
            </div>
          </div>

          <div className="card">
            <h2 className="font-semibold text-gray-900">Report History</h2>
            {reports.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500">No reports have been generated.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {reports.slice(0, 8).map((report, index) => (
                  <div key={report.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-900">{index === 0 ? 'Latest report' : `Report ${index + 1}`}</span>
                      <span className="badge badge-gray">{report.type}</span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">{formatDate(report.createdAt)}</div>
                    {projectId && (
                      <a href={api.downloadReport(report.id, projectId)} download className="mt-2 inline-block text-xs font-medium text-brand-700 hover:text-brand-800">
                        Download
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
