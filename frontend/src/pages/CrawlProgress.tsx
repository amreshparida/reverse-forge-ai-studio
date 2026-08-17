import { useEffect, useState, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { DeleteSessionConfirmModal } from '../components/DeleteConfirmModal';
import type { CrawlLogEntry, CrawlSession, Job } from '../types';

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-gray-200 rounded-full h-3">
      <div
        className="bg-brand-600 h-3 rounded-full transition-all duration-300"
        style={{ width: `${Math.min(100, value)}%` }}
      />
    </div>
  );
}

export default function CrawlProgress() {
  const { projectId, sessionId } = useParams<{ projectId: string; sessionId: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<CrawlSession | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [stopLoading, setStopLoading] = useState(false);
  const [markCompleteLoading, setMarkCompleteLoading] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [logs, setLogs] = useState<CrawlLogEntry[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const appendLogs = (incoming: CrawlLogEntry[]) => {
    if (incoming.length === 0) return;
    setLogs((prev) => {
      const byId = new Map(prev.map((entry) => [entry.id, entry]));
      incoming.forEach((entry) => byId.set(entry.id, entry));
      return Array.from(byId.values()).sort((a, b) => a.id - b.id).slice(-300);
    });
  };

  const load = async () => {
    if (!projectId || !sessionId) return;
    try {
      const data = await api.getCrawl(projectId, sessionId);
      setSession(data.session);
      setJob(data.job);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    pollRef.current = setInterval(() => { void load(); }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!projectId || !sessionId) return;
    setLogs([]);
    api.getCrawlLogs(projectId, sessionId)
      .then((data) => appendLogs(data.logs))
      .catch(() => undefined);
  }, [projectId, sessionId]);

  // Stop polling when done
  useEffect(() => {
    if (session && ['completed', 'failed', 'stopped'].includes(session.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
    }
  }, [session?.status]);

  // SSE for job progress
  useEffect(() => {
    const jobIds = new Set([`crawl-${sessionId}`, `agent-${sessionId}`, `collab-${sessionId}`, `manual-${sessionId}`, `report-${sessionId}`]);
    const evtSource = new EventSource('/api/events');
    evtSource.addEventListener('job', (e) => {
      const j = JSON.parse(e.data) as Job;
      if (jobIds.has(j.id)) setJob(j);
    });
    evtSource.addEventListener('crawl-log', (e) => {
      const entry = JSON.parse(e.data) as CrawlLogEntry;
      if (entry.sessionId === sessionId) appendLogs([entry]);
    });
    return () => evtSource.close();
  }, [sessionId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [logs.length]);

  const handleStop = async () => {
    if (!projectId || !sessionId) return;
    setStopLoading(true);
    try {
      await api.stopCrawl(projectId, sessionId);
      await load();
    } finally {
      setStopLoading(false);
    }
  };

  const handleMarkComplete = async () => {
    if (!projectId || !sessionId) return;
    setMarkCompleteLoading(true);
    try {
      const data = await api.markCrawlComplete(projectId, sessionId);
      setSession(data.session);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to mark session complete');
    } finally {
      setMarkCompleteLoading(false);
    }
  };

  if (loading)
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" /></div>;

  if (!session) return <div className="text-red-600">Session not found</div>;

  const isRunning = session.status === 'running' || session.status === 'pending';
  const isAwaitingLogin = session.status === 'awaiting_login';
  const isDone = ['completed', 'failed', 'stopped'].includes(session.status);
  const canMarkComplete = session.status === 'failed' || session.status === 'stopped';
  const canDelete = !isRunning && !isAwaitingLogin;
  const showLiveLog = isRunning && !isAwaitingLogin;
  const progress = job?.progress ?? (isDone ? 100 : 0);

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        <Link to="/projects" className="hover:text-gray-900">Projects</Link>
        <span>/</span>
        <Link to={`/projects/${projectId}`} className="hover:text-gray-900">{projectId?.slice(0, 8)}</Link>
        <span>/</span>
        <span className="text-gray-900">Crawl</span>
      </div>

      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-gray-900">Crawl Progress</h1>
          <span className={`badge ${
            session.status === 'running' ? 'badge-blue' :
            session.status === 'completed' ? 'badge-green' :
            session.status === 'failed' ? 'badge-red' :
            'badge-gray'
          }`}>
            {session.status}
          </span>
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-sm text-gray-500 mb-1.5">
            <span>Progress</span>
            <span>{progress.toFixed(0)}%</span>
          </div>
          <ProgressBar value={progress} />
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-gray-500">Pages captured</div>
            <div className="text-2xl font-bold text-brand-600">{session.pagesCount}</div>
          </div>
          <div>
            <div className="text-gray-500">Session ID</div>
            <div className="font-mono text-xs text-gray-600 mt-1">{session.id.slice(0, 16)}...</div>
          </div>
        </div>

        {session.startedAt && (
          <div className="mt-3 text-xs text-gray-500">
            Started: {new Date(session.startedAt).toLocaleString()}
            {session.finishedAt && ` · Finished: ${new Date(session.finishedAt).toLocaleString()}`}
          </div>
        )}

        {session.errorMessage && (
          <div className="mt-3 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
            <strong>Error:</strong> {session.errorMessage}
            {session.errorMessage.toLowerCase().includes('login') && (
              <div className="mt-1 text-xs text-red-600">
                → Start a new crawl — a browser will open for you to log in again.
              </div>
            )}
          </div>
        )}

        {isAwaitingLogin && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="animate-bounce text-xl">🔑</div>
              <span className="font-semibold text-amber-800">Waiting for Login</span>
            </div>
            <ol className="text-sm text-amber-700 space-y-1 list-decimal list-inside">
              <li>A browser window has opened at your login page.</li>
              <li>Fill in your credentials and log in normally.</li>
              <li>
                Once logged in, click the{' '}
                <strong className="bg-indigo-600 text-white px-2 py-0.5 rounded text-xs">
                  {job?.type === 'manual-crawl' ? 'Start capture' : '✓ Done — Start Crawling'}
                </strong>{' '}
                button in the browser.
              </li>
            </ol>
            <p className="text-xs text-amber-600 mt-2">
              {job?.type === 'manual-crawl'
                ? 'Then explore normally. New URLs are captured automatically; use Capture current state for tabs and modals, and Finish & save when done.'
                : <>The crawl will start automatically after you click that button. For <strong>XpertCrawl</strong>, both agents will start from that same page.</>}
            </p>
          </div>
        )}

        {isRunning && !isAwaitingLogin && (
          <div className="mt-4 flex items-center gap-2">
            <div className="animate-pulse w-2 h-2 bg-blue-500 rounded-full" />
            <span className="text-sm text-blue-600">
              {job?.type === 'manual-crawl'
                ? 'Manual capture is active in the browser. Explore normally, capture dynamic states, then click Finish & save.'
                : 'Crawling in progress...'}
            </span>
            </div>
        )}
      </div>

      {showLiveLog && (
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-gray-900">Live Crawl Log</h2>
            <span className="text-xs text-gray-500">{logs.length} events</span>
          </div>
          <div className="h-80 overflow-y-auto rounded-md bg-gray-950 px-3 py-2 font-mono text-xs text-gray-100">
            {logs.length === 0 ? (
              <div className="text-gray-400">Waiting for crawler activity...</div>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className="flex gap-2 border-b border-white/5 py-1 last:border-0">
                  <span className="shrink-0 text-gray-500">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={`shrink-0 uppercase ${
                    entry.level === 'error' ? 'text-red-300' :
                    entry.level === 'warn' ? 'text-amber-300' :
                    entry.level === 'debug' ? 'text-gray-400' :
                    'text-blue-300'
                  }`}>
                    {entry.level}
                  </span>
                  <span className="min-w-0 break-all text-gray-100">{entry.message}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {(isRunning || isAwaitingLogin) && (
          <button onClick={() => { void handleStop(); }} disabled={stopLoading} className="btn-danger">
            {stopLoading ? 'Stopping...' : '⏹ Stop Crawl'}
          </button>
        )}
        {isDone && (
          <>
            <Link to={`/projects/${projectId}/crawls/${sessionId}/pages`} className="btn-primary">
              View Pages
            </Link>
            <Link to={`/projects/${projectId}/crawls/${sessionId}/api`} className="btn-secondary">
              View API Calls
            </Link>
          </>
        )}
        {canMarkComplete && (
          <button
            type="button"
            className="btn-secondary"
            disabled={markCompleteLoading}
            title="Treat this session as completed so it appears in analysis and report generation"
            onClick={() => { void handleMarkComplete(); }}
          >
            {markCompleteLoading ? 'Updating...' : '✓ Mark as Complete'}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className="btn-danger ml-auto"
            onClick={() => setShowDeleteModal(true)}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete Session
          </button>
        )}
      </div>

      {showDeleteModal && projectId && (
        <DeleteSessionConfirmModal
          projectId={projectId}
          session={{
            id: session.id,
            pagesCount: session.pagesCount,
            status: session.status,
            createdAt: session.createdAt,
          }}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={() => navigate(`/projects/${projectId}`)}
        />
      )}
    </div>
  );
}
