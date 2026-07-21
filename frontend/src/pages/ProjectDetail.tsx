import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { DeleteSessionConfirmModal } from '../components/DeleteConfirmModal';
import type { Project, CrawlSession } from '../types';

function SessionStatus({ status }: { status: CrawlSession['status'] }) {
  const map: Record<string, string> = {
    pending: 'badge-yellow',
    awaiting_login: 'badge-yellow',
    running: 'badge-blue',
    completed: 'badge-green',
    failed: 'badge-red',
    stopped: 'badge-gray',
  };
  const label: Record<string, string> = {
    awaiting_login: 'waiting for login',
  };
  const text = label[status] ?? status.replace('_', ' ');
  return <span className={`badge ${map[status] ?? 'badge-gray'}`}>{text}</span>;
}

export default function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [crawlLoading, setCrawlLoading] = useState(false);
  const [agentLoading, setAgentLoading] = useState(false);
  const [collabLoading, setCollabLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [deleteSession, setDeleteSession] = useState<CrawlSession | null>(null);
  const [markingCompleteId, setMarkingCompleteId] = useState<string | null>(null);

  const load = () => {
    if (!projectId) return;
    api.getProject(projectId)
      .then((data) => setProject(data.project))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [projectId]);

  const isActiveCrawl = (status: CrawlSession['status']) =>
    status === 'running' || status === 'pending' || status === 'awaiting_login';

  const goToActiveCrawlIfAny = (): boolean => {
    if (!projectId) return false;
    const sessions = project?.crawlSessions ?? [];
    const active = sessions.find((session) => isActiveCrawl(session.status));
    if (!active) return false;
    navigate(`/projects/${projectId}/crawls/${active.id}`);
    return true;
  };

  const handleStartCrawl = async () => {
    if (!projectId) return;
    if (goToActiveCrawlIfAny()) return;
    setCrawlLoading(true);
    try {
      const res = await api.startCrawl(projectId);
      navigate(`/projects/${projectId}/crawls/${res.session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start crawl');
      setCrawlLoading(false);
    }
  };

  const handleAgentCrawl = async () => {
    if (!projectId) return;
    if (goToActiveCrawlIfAny()) return;
    setAgentLoading(true);
    try {
      const res = await api.startAgentCrawl(projectId);
      navigate(`/projects/${projectId}/crawls/${res.session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Agent crawl requires LLM_API_KEY to be configured');
      setAgentLoading(false);
    }
  };

  const handleCollaborativeCrawl = async () => {
    if (!projectId) return;
    if (goToActiveCrawlIfAny()) return;
    setCollabLoading(true);
    try {
      const res = await api.startCollaborativeCrawl(projectId);
      navigate(`/projects/${projectId}/crawls/${res.session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start collaborative crawl');
      setCollabLoading(false);
    }
  };

  const handleExtractReport = async () => {
    if (!projectId) return;
    setReportLoading(true);
    setMsg(null);
    try {
      const res = await api.generateProjectReport(projectId);
      setMsg(res.message);
      navigate(`/projects/${projectId}/reports`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to extract report');
    } finally {
      setReportLoading(false);
    }
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" />
      </div>
    );

  if (error) return <div className="text-red-600">{error}</div>;
  if (!project) return null;
  const sessions = project.crawlSessions ?? [];
  const completedSessions = sessions.filter((session) => session.status === 'completed');
  const activeSessions = sessions.filter((session) => isActiveCrawl(session.status));
  const hasActiveCrawl = activeSessions.length > 0;
  const hasAnySession = sessions.length > 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link to="/projects" className="hover:text-gray-900">Projects</Link>
            <span>/</span>
            <span className="text-gray-900 font-medium">{project.name}</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
          <a href={project.baseUrl} target="_blank" rel="noopener noreferrer" className="text-brand-600 text-sm hover:underline">
            {project.baseUrl}
          </a>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/projects/${projectId}/edit`} className="btn-secondary">
            ✏ Edit
          </Link>
          {hasActiveCrawl ? (
            <button
              type="button"
              onClick={() => { goToActiveCrawlIfAny(); }}
              title="Open the active crawl progress screen"
              className="btn-primary"
            >
              ↗ Open Crawl
            </button>
          ) : (
            <>
              <button
                onClick={() => { void handleStartCrawl(); }}
                disabled={crawlLoading || agentLoading || collabLoading}
                title="BFS Crawler: systematically follows all links breadth-first."
                className="btn-secondary"
              >
                {crawlLoading ? 'Starting…' : '🕷 BFS Crawler'}
              </button>
              <button
                onClick={() => { void handleAgentCrawl(); }}
                disabled={agentLoading || crawlLoading || collabLoading}
                title="LLM-driven: Planner → Navigator → Observer loop. Intelligently explores tabs, dynamic content and hidden pages."
                className="btn-secondary"
              >
                {agentLoading ? 'Starting…' : '🤖 Agentic Crawler'}
              </button>
              <button
                onClick={() => { void handleCollaborativeCrawl(); }}
                disabled={collabLoading || crawlLoading || agentLoading || reportLoading}
                title="Xpert Crawler: BFS Explorer + LLM Navigator run simultaneously, sharing a live knowledge base."
                className="btn-secondary border-brand-300 text-brand-700 hover:bg-brand-50"
              >
                {collabLoading ? 'Starting…' : '⚡ Xpert Crawler'}
              </button>
            </>
          )}
          {hasAnySession && (
            <button
              onClick={() => { void handleExtractReport(); }}
              disabled={reportLoading || completedSessions.length === 0 || crawlLoading || agentLoading || collabLoading}
              title={completedSessions.length === 0 ? 'Complete at least one crawl session before extracting a project report.' : 'Runs the full analysis orchestrator across all completed sessions in this project.'}
              className="btn-primary"
            >
              {reportLoading ? 'Extracting...' : 'Extract Report'}
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 rounded-lg p-3 text-sm mb-4">
          {msg}
        </div>
      )}

      {activeSessions.length > 0 && (
        <div className="mb-6 space-y-2">
          {activeSessions.map((session) => (
            <div
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-brand-900">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-500" />
                  Crawl in progress
                  <SessionStatus status={session.status} />
                </div>
                <p className="mt-0.5 text-xs text-brand-700/80">
                  {session.pagesCount > 0 ? `${session.pagesCount} pages so far` : 'Starting…'}
                  {' · '}
                  started {new Date(session.createdAt).toLocaleString()}
                </p>
              </div>
              <Link
                to={`/projects/${projectId}/crawls/${session.id}`}
                className="btn-primary shrink-0 !px-3 !py-1.5 text-sm"
              >
                Open progress
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <div className="card text-center">
          <div className="text-3xl font-bold text-brand-600">{sessions.length}</div>
          <div className="text-sm text-gray-500 mt-1">Crawl Sessions</div>
        </div>
        <div className="card text-center">
          <div className="text-3xl font-bold text-gray-700">{project.crawlDepth}</div>
          <div className="text-sm text-gray-500 mt-1">Max Depth</div>
        </div>
        <div className="card text-center">
          <div className={`text-3xl font-bold ${project.loginRequired ? 'text-brand-600' : 'text-gray-400'}`}>
            {project.loginRequired ? 'YES' : 'NO'}
          </div>
          <div className="text-sm text-gray-500 mt-1">Login Required</div>
        </div>
      </div>

      {/* Config + Sessions */}
      <div className="grid gap-6 grid-cols-1">
        <div className="card">
          <h2 className="font-semibold text-gray-900 mb-3">Configuration</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Login Required</dt>
              <dd className="font-medium">{project.loginRequired ? 'Yes' : 'No'}</dd>
            </div>
            {project.loginUrl && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Login URL</dt>
                <dd className="font-medium text-xs truncate ml-4 max-w-xs">{project.loginUrl}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-gray-500">Screenshots</dt>
              <dd>{project.screenshotEnabled ? '✓ Enabled' : '✗ Disabled'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Network Capture</dt>
              <dd>{project.networkCaptureEnabled ? '✓ Enabled' : '✗ Disabled'}</dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h2 className="font-semibold text-gray-900 mb-3">Crawl Sessions</h2>
          {sessions.length === 0 ? (
            <p className="text-gray-500 text-sm">No crawl sessions yet.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => {
                const canDelete = session.status !== 'running' && session.status !== 'awaiting_login';
                const canMarkComplete = session.status === 'failed' || session.status === 'stopped';
                return (
                  <div
                    key={session.id}
                    className="group flex items-center gap-2 rounded-lg border border-gray-100 p-3 transition-colors hover:border-brand-200 hover:bg-brand-50"
                  >
                    <Link
                      to={`/projects/${projectId}/crawls/${session.id}`}
                      className="min-w-0 flex-1"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            {session.pagesCount > 0 ? session.pagesCount : (session._count?.pages ?? 0)} pages
                            {(session.status === 'running' ||
                              session.status === 'pending' ||
                              session.status === 'awaiting_login') && (
                              <span className="ml-2 text-xs font-medium text-brand-600">
                                · Open progress
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500">
                            {new Date(session.createdAt).toLocaleString()}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400">
                            {session.id}
                          </div>
                        </div>
                        <SessionStatus status={session.status} />
                      </div>
                    </Link>
                    {canMarkComplete && (
                      <button
                        type="button"
                        title="Mark as complete"
                        aria-label={`Mark session ${session.id} as complete`}
                        disabled={markingCompleteId === session.id}
                        className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium text-emerald-700 opacity-0 transition-opacity hover:bg-emerald-50 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!projectId) return;
                          setMarkingCompleteId(session.id);
                          void api.markCrawlComplete(projectId, session.id)
                            .then(() => load())
                            .catch((err: Error) => setMsg(err.message))
                            .finally(() => setMarkingCompleteId(null));
                        }}
                      >
                        {markingCompleteId === session.id ? '…' : '✓ Complete'}
                      </button>
                    )}
                    <button
                      type="button"
                      title={canDelete ? 'Delete session' : 'Stop the crawl before deleting'}
                      aria-label={`Delete session ${session.id}`}
                      disabled={!canDelete}
                      className="shrink-0 rounded-lg p-1.5 text-gray-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (canDelete) setDeleteSession(session);
                      }}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-3 mt-6">
        <Link to={`/projects/${projectId}/analysis`} className="btn-secondary">View Analysis</Link>
        <Link to={`/projects/${projectId}/reports`} className="btn-secondary">View Reports</Link>
      </div>

      {deleteSession && projectId && (
        <DeleteSessionConfirmModal
          projectId={projectId}
          session={{
            id: deleteSession.id,
            pagesCount: deleteSession.pagesCount > 0
              ? deleteSession.pagesCount
              : (deleteSession._count?.pages ?? 0),
            status: deleteSession.status,
            createdAt: deleteSession.createdAt,
          }}
          onClose={() => setDeleteSession(null)}
          onDeleted={() => {
            setDeleteSession(null);
            load();
          }}
        />
      )}
    </div>
  );
}

