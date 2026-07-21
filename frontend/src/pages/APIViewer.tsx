import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import type { NetworkCall } from '../types';

function statusColor(status?: number) {
  if (!status) return 'text-gray-400';
  if (status < 300) return 'text-green-600';
  if (status < 400) return 'text-yellow-600';
  return 'text-red-600';
}

function methodBadge(method?: string) {
  const colors: Record<string, string> = {
    GET: 'bg-green-100 text-green-700',
    POST: 'bg-blue-100 text-blue-700',
    PUT: 'bg-yellow-100 text-yellow-700',
    PATCH: 'bg-orange-100 text-orange-700',
    DELETE: 'bg-red-100 text-red-700',
  };
  const color = colors[method ?? ''] ?? 'bg-gray-100 text-gray-600';
  return <span className={`badge ${color}`}>{method ?? '?'}</span>;
}

function DetailField({ label, value, mono = false }: { label: string; value: unknown; mono?: boolean }) {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
      <pre className={`${mono ? 'font-mono' : ''} text-xs bg-gray-50 rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap break-words`}>
        {text}
      </pre>
    </div>
  );
}

export default function APIViewer() {
  const { projectId, sessionId } = useParams<{ projectId: string; sessionId: string }>();
  const [calls, setCalls] = useState<NetworkCall[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<NetworkCall | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    api.getNetworkCalls(projectId, sessionId, page)
      .then((data) => {
        setCalls(data.calls);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }, [projectId, sessionId, page]);

  const filtered = search
    ? calls.filter((c) => c.url.toLowerCase().includes(search.toLowerCase()))
    : calls;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link to={`/projects/${projectId}/crawls/${sessionId}`} className="hover:text-gray-900">← Crawl</Link>
          </div>
          <h1 className="text-xl font-bold text-gray-900">API Calls ({total})</h1>
        </div>
        <input
          type="text"
          placeholder="Search URLs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
      </div>

      <div className="card overflow-hidden">
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th className="w-1/2">URL</th>
              <th>Status</th>
              <th>Time</th>
              <th>Page</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={5}><div className="animate-pulse h-4 bg-gray-100 rounded" /></td>
                  </tr>
                ))
              : filtered.map((call) => (
                  <tr
                    key={call.id}
                    className="cursor-pointer hover:bg-brand-50"
                    onClick={() => setSelected(selected?.id === call.id ? null : call)}
                  >
                    <td>{methodBadge(call.method)}</td>
                    <td className="font-mono text-xs max-w-xs truncate text-gray-700">{call.url}</td>
                    <td className={`font-mono text-sm font-medium ${statusColor(call.responseStatus)}`}>
                      {call.responseStatus ?? '—'}
                    </td>
                    <td className="text-xs text-gray-500">{call.timingMs ? `${call.timingMs.toFixed(0)}ms` : '—'}</td>
                    <td className="text-xs text-gray-500 truncate max-w-xs">
                      {call.pageCapture?.title ?? call.pageCapture?.url ?? '—'}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 50 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button className="btn-secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="text-sm text-gray-500">Page {page} of {Math.ceil(total / 50)}</span>
          <button className="btn-secondary" disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="fixed inset-y-0 right-0 w-[640px] max-w-full bg-white border-l border-gray-200 shadow-xl overflow-y-auto z-40 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Request Detail</h2>
            <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-700">✕</button>
          </div>

          <div className="flex items-center gap-2 mb-3">
            {methodBadge(selected.method)}
            <span className={`font-mono text-sm ${statusColor(selected.responseStatus)}`}>
              {selected.responseStatus}
            </span>
            {selected.timingMs && <span className="text-xs text-gray-500">{selected.timingMs.toFixed(0)}ms</span>}
          </div>

          <section className="mb-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Request</h3>
            <DetailField label="Method" value={selected.method} />
            <DetailField label="URL" value={selected.url} mono />
            <DetailField label="Resource Type" value={selected.resourceType} />
            <DetailField label="Request Content Type" value={selected.requestContentType} />
            <DetailField label="Query Params" value={selected.queryParams} mono />
            <DetailField label="Request Headers" value={selected.requestHeaders} mono />
            <DetailField label="Request Payload" value={selected.requestPayload} mono />
            <DetailField label="GraphQL" value={selected.isGraphQL ? 'Yes' : undefined} />
            <DetailField label="GraphQL Operation" value={selected.graphQLOperationName} />
          </section>

          <section className="mb-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Response</h3>
            <DetailField label="Status" value={selected.responseStatus} />
            <DetailField label="Timing" value={selected.timingMs ? `${selected.timingMs.toFixed(0)}ms` : undefined} />
            <DetailField label="Response Content Type" value={selected.responseContentType} />
            <DetailField label="Response Headers" value={selected.responseHeaders} mono />
            <DetailField label="Response Schema Keys" value={selected.responseSchemaKeys} mono />
            <DetailField label="Response Body" value={selected.responseBody} mono />
          </section>

          {selected.pageCapture && (
            <div className="text-xs text-gray-500 mt-2">
              From page: {selected.pageCapture.title ?? selected.pageCapture.url}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
