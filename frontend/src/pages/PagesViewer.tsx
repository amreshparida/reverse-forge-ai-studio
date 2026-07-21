import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import type { PageCapture } from '../types';

function staticPath(path: string) {
  return `/static/${path.replace(/\\/g, '/')}`;
}

function ScreenshotPlaceholder({ className = '' }: { className?: string }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-1 bg-gradient-to-br from-gray-100 to-gray-200 text-gray-400 ${className}`}
      aria-hidden
    >
      <svg className="h-5 w-5 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z"
        />
      </svg>
      <span className="text-[10px] font-medium leading-none">No image</span>
    </div>
  );
}

function PageThumbnail({
  path,
  alt,
  className = 'shrink-0 w-16 h-12 rounded overflow-hidden border border-gray-200',
}: {
  path?: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(path) && !failed;

  if (!showImage) {
    return <ScreenshotPlaceholder className={className} />;
  }

  return (
    <div className={className}>
      <img
        src={staticPath(path!)}
        alt={alt}
        className="h-full w-full object-cover object-top"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function PageDetailModal({
  page,
  loading,
  onClose,
}: {
  page: PageCapture;
  loading: boolean;
  onClose: () => void;
}) {
  const imagePath = page.fullScreenshotPath || page.screenshotPath;
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imagePath]);

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
        <div className="min-w-0 pr-4">
          <h2 className="text-xl font-semibold text-gray-900 truncate">{page.title || '(no title)'}</h2>
          <p className="text-sm text-gray-500 truncate">{page.url}</p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 text-gray-400 hover:text-gray-700 text-2xl leading-none"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-1 min-h-0 flex-col xl:flex-row">
        <div className="xl:w-1/2 bg-gray-950 border-b xl:border-b-0 xl:border-r border-gray-200 overflow-y-auto">
          {imagePath && !imageFailed ? (
            <img
              src={staticPath(imagePath)}
              alt={page.title || 'Page screenshot'}
              className="w-full h-auto"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="flex min-h-[16rem] h-full flex-col items-center justify-center gap-3 bg-gray-900 text-gray-500">
              <svg className="h-12 w-12 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z"
                />
              </svg>
              <span className="text-sm">No screenshot available</span>
            </div>
          )}
        </div>

        <div className="xl:w-1/2 overflow-y-auto p-6">
            {loading ? (
              <div className="flex items-center justify-center h-40">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <span className="badge badge-gray">depth {page.depth}</span>
                  {page.loadTimeMs != null && (
                    <span className="badge badge-gray">{page.loadTimeMs}ms</span>
                  )}
                  {page._count?.networkCalls ? (
                    <span className="badge badge-blue">{page._count.networkCalls} API calls</span>
                  ) : null}
                  {page.aiAnalysis && <span className="badge badge-green">AI analyzed</span>}
                </div>

                {page.breadcrumbs && page.breadcrumbs.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-gray-500 mb-1">Breadcrumbs</p>
                    <p className="text-xs text-gray-700">{page.breadcrumbs.join(' › ')}</p>
                  </div>
                )}

                {page.aiAnalysis && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-gray-500 mb-2">AI Analysis</p>
                    <div className="bg-brand-50 rounded-lg p-3 text-xs space-y-1">
                      <div><span className="font-medium">Module:</span> {page.aiAnalysis.businessModule}</div>
                      <div><span className="font-medium">Entity:</span> {page.aiAnalysis.primaryEntity}</div>
                      <div><span className="font-medium">Purpose:</span> {page.aiAnalysis.pagePurpose}</div>
                      <div><span className="font-medium">Stage:</span> {page.aiAnalysis.workflowStage}</div>
                      {page.aiAnalysis.possibleRoles.length > 0 && (
                        <div><span className="font-medium">Roles:</span> {page.aiAnalysis.possibleRoles.join(', ')}</div>
                      )}
                    </div>
                  </div>
                )}

                {page.extractedData?.forms?.length ? (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-gray-500 mb-2">Forms ({page.extractedData.forms.length})</p>
                    {page.extractedData.forms.map((form, i) => (
                      <div key={i} className="bg-gray-50 rounded-lg p-3 text-xs mb-2">
                        <div className="font-medium mb-1">{form.title || 'Form'}</div>
                        {form.fields.map((f, j) => (
                          <div key={j} className="text-gray-600">
                            {f.label || f.name} ({f.type}){f.required ? ' *' : ''}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}

                {page.extractedData?.tables?.length ? (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-gray-500 mb-2">Tables ({page.extractedData.tables.length})</p>
                    {page.extractedData.tables.map((t, i) => (
                      <div key={i} className="bg-gray-50 rounded-lg p-3 text-xs mb-2">
                        <div className="font-medium mb-1">{t.title || 'Table'}</div>
                        <div className="text-gray-600">{t.columns.map((c) => c.header).filter(Boolean).join(', ')}</div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {!page.aiAnalysis && !page.extractedData?.forms?.length && !page.extractedData?.tables?.length && (
                  <p className="text-sm text-gray-500">No additional extracted content for this page.</p>
                )}
              </>
            )}
          </div>
        </div>
    </div>
  );
}

export default function PagesViewer() {
  const { projectId, sessionId } = useParams<{ projectId: string; sessionId: string }>();
  const [pages, setPages] = useState<PageCapture[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedPage, setSelectedPage] = useState<PageCapture | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!projectId || !sessionId) return;
    setLoading(true);
    api.getPages(projectId, sessionId, page)
      .then((data) => {
        setPages(data.pages);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }, [projectId, sessionId, page]);

  const openPageDetail = async (p: PageCapture) => {
    if (!projectId || !sessionId) return;
    setSelectedPage(p);
    setDetailLoading(true);
    try {
      const data = await api.getPage(projectId, sessionId, p.id);
      setSelectedPage(data.page);
    } finally {
      setDetailLoading(false);
    }
  };

  const filtered = search
    ? pages.filter((p) =>
        p.url.toLowerCase().includes(search.toLowerCase()) ||
        (p.title ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : pages;

  return (
    <div>
      {selectedPage && (
        <PageDetailModal
          page={selectedPage}
          loading={detailLoading}
          onClose={() => setSelectedPage(null)}
        />
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link to={`/projects/${projectId}/crawls/${sessionId}`} className="hover:text-gray-900">← Crawl</Link>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Pages ({total})</h1>
        </div>
        <input
          type="text"
          placeholder="Search pages..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card animate-pulse h-32 bg-gray-50" />
            ))
          : filtered.map((p) => (
              <div
                key={p.id}
                className="card cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => { void openPageDetail(p); }}
              >
                <div className="flex items-start gap-3">
                  <PageThumbnail
                    path={p.screenshotPath || p.fullScreenshotPath}
                    alt={p.title || 'Page thumbnail'}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {p.title || '(no title)'}
                    </div>
                    <div className="text-xs text-gray-500 truncate">{p.url}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="badge badge-gray">depth {p.depth}</span>
                      {p._count?.networkCalls ? (
                        <span className="badge badge-blue">{p._count.networkCalls} API</span>
                      ) : null}
                      {p.aiAnalysis && <span className="badge badge-green">AI ✓</span>}
                    </div>
                  </div>
                </div>
              </div>
            ))}
      </div>

      {/* Pagination */}
      {total > 50 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          <button
            className="btn-secondary"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className="text-sm text-gray-500">
            Page {page} of {Math.ceil(total / 50)}
          </span>
          <button
            className="btn-secondary"
            disabled={page * 50 >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
