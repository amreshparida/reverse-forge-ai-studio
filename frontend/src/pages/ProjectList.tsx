import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import type { Project } from '../types';

function StatusBadge({ count }: { count: number }) {
  if (count === 0) return <span className="badge badge-gray">No crawls</span>;
  return <span className="badge badge-blue">{count} crawl{count !== 1 ? 's' : ''}</span>;
}

export default function ProjectList() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .getProjects()
      .then((data) => setProjects(data.projects))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!menuOpenId) return;

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpenId(null);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpenId(null);
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpenId]);

  async function handleClone(project: Project) {
    if (cloningId) return;
    setMenuOpenId(null);
    setActionError(null);
    setCloningId(project.id);
    try {
      const { project: cloned } = await api.cloneProject(project.id);
      setProjects((prev) => [cloned, ...prev]);
      navigate(`/projects/${cloned.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to clone project');
    } finally {
      setCloningId(null);
    }
  }

  if (loading)
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" />
      </div>
    );

  if (error) return <div className="text-red-600 p-4">Error: {error}</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-500 text-sm mt-1">Manage your reverse engineering projects</p>
        </div>
        <Link to="/projects/new" className="btn-primary">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Project
        </Link>
      </div>

      {actionError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {projects.length === 0 ? (
        <div className="card text-center py-16">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 className="font-semibold text-gray-900 mb-1">No projects yet</h3>
          <p className="text-gray-500 text-sm mb-4">Create your first project to start analyzing a web application.</p>
          <Link to="/projects/new" className="btn-primary mx-auto">Create Project</Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const menuOpen = menuOpenId === project.id;
            return (
              <div key={project.id} className="card hover:shadow-md transition-shadow relative">
                <div
                  className="absolute top-3 right-3 z-20"
                  ref={menuOpen ? menuRef : undefined}
                >
                  <button
                    type="button"
                    title="Project actions"
                    aria-label={`Actions for ${project.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    onClick={() => setMenuOpenId(menuOpen ? null : project.id)}
                  >
                    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z" />
                    </svg>
                  </button>

                  {menuOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 mt-1 w-36 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        disabled={cloningId === project.id}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60"
                        onClick={() => void handleClone(project)}
                      >
                        <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        {cloningId === project.id ? 'Cloning…' : 'Clone'}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                        onClick={() => {
                          setMenuOpenId(null);
                          setDeleteTarget(project);
                        }}
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Delete
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex items-start justify-between mb-3 pr-8">
                  <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center shrink-0">
                    <span className="text-brand-600 font-bold text-sm">
                      {project.name.slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <StatusBadge count={project._count?.crawlSessions ?? 0} />
                </div>
                <h3 className="font-semibold text-gray-900 mb-1">{project.name}</h3>
                <p className="text-xs text-gray-500 truncate mb-3">{project.baseUrl}</p>
                <div className="flex flex-wrap gap-1.5">
                  {project.screenshotEnabled && (
                    <span className="badge badge-gray">Screenshots</span>
                  )}
                  {project.networkCaptureEnabled && (
                    <span className="badge badge-gray">Network</span>
                  )}
                </div>
                <div className="mt-4 flex items-center justify-between gap-2">
                  <p className="text-xs text-gray-400">
                    Created {new Date(project.createdAt).toLocaleDateString()}
                  </p>
                  <Link
                    to={`/projects/${project.id}`}
                    className="btn-primary !px-2.5 !py-1 text-xs"
                  >
                    View
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          project={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(id) => setProjects((prev) => prev.filter((p) => p.id !== id))}
        />
      )}
    </div>
  );
}
