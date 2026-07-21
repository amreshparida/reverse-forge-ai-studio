import { useState } from 'react';
import { api } from '../api/client';

export function TypeConfirmDeleteModal({
  title,
  description,
  confirmValue,
  confirmHint,
  confirmButtonLabel = 'Delete forever',
  onClose,
  onConfirm,
}: {
  title: string;
  description: React.ReactNode;
  /** Exact string the user must type to enable delete */
  confirmValue: string;
  /** Shown in the “Type X to confirm” label; defaults to confirmValue */
  confirmHint?: string;
  confirmButtonLabel?: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hint = confirmHint ?? confirmValue;
  const canDelete = typed === confirmValue;

  const handleDelete = async () => {
    if (!canDelete || loading) return;
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close dialog"
        onClick={onClose}
        disabled={loading}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="type-confirm-delete-title"
        className="relative w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          <div>
            <h2 id="type-confirm-delete-title" className="text-lg font-semibold text-gray-900">
              {title}
            </h2>
            <div className="mt-1 text-sm text-gray-600">{description}</div>
          </div>
        </div>

        <label htmlFor="type-confirm-delete-input" className="mb-1 block text-sm font-medium text-gray-700">
          Type <span className="break-all font-semibold text-gray-900">{hint}</span> to confirm
        </label>
        <input
          id="type-confirm-delete-input"
          type="text"
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleDelete();
            if (e.key === 'Escape') onClose();
          }}
          placeholder={hint}
          disabled={loading}
          className="mb-3"
        />

        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={!canDelete || loading}
            onClick={() => { void handleDelete(); }}
          >
            {loading ? 'Deleting…' : confirmButtonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export type DeletableProject = {
  id: string;
  name: string;
};

export function DeleteConfirmModal({
  project,
  onClose,
  onDeleted,
}: {
  project: DeletableProject;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  return (
    <TypeConfirmDeleteModal
      title="Delete project"
      description={
        <>
          This permanently removes <span className="font-medium text-gray-900">{project.name}</span> and
          all related data: crawl sessions, pages, APIs, analysis, reports, and files on disk.
        </>
      }
      confirmValue={project.name}
      onClose={onClose}
      onConfirm={async () => {
        await api.deleteProject(project.id, project.name);
        onDeleted(project.id);
      }}
    />
  );
}

export function DeleteSessionConfirmModal({
  projectId,
  session,
  onClose,
  onDeleted,
}: {
  projectId: string;
  session: { id: string; pagesCount?: number; status: string; createdAt: string };
  onClose: () => void;
  onDeleted: (sessionId: string) => void;
}) {
  return (
    <TypeConfirmDeleteModal
      title="Delete crawl session"
      description={
        <>
          This permanently removes this crawl session
          ({session.pagesCount ?? 0} pages, {session.status}) and its pages, API captures,
          analysis graph data, reports, and files on disk.
          <div className="mt-2 break-all rounded bg-gray-50 px-2 py-1 font-mono text-xs text-gray-700">
            {session.id}
          </div>
        </>
      }
      confirmValue={session.id}
      onClose={onClose}
      onConfirm={async () => {
        await api.deleteSession(projectId, session.id, session.id);
        onDeleted(session.id);
      }}
    />
  );
}
