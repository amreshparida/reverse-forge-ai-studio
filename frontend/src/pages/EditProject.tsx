import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import type { Project } from '../types';

interface FormState {
  name: string;
  baseUrl: string;
  loginUrl: string;
  loginRequired: boolean;
  crawlDepth: number;
  allowedDomains: string;
  excludedUrls: string;
  screenshotEnabled: boolean;
  networkCaptureEnabled: boolean;
}

function projectToForm(p: Project): FormState {
  return {
    name: p.name,
    baseUrl: p.baseUrl,
    loginUrl: p.loginUrl ?? '',
    loginRequired: p.loginRequired,
    crawlDepth: p.crawlDepth,
    allowedDomains: Array.isArray((p as unknown as { allowedDomains: unknown }).allowedDomains)
      ? ((p as unknown as { allowedDomains: string[] }).allowedDomains).join('\n')
      : '',
    excludedUrls: Array.isArray((p as unknown as { excludedUrls: unknown }).excludedUrls)
      ? ((p as unknown as { excludedUrls: string[] }).excludedUrls).join('\n')
      : '',
    screenshotEnabled: p.screenshotEnabled,
    networkCaptureEnabled: p.networkCaptureEnabled,
  };
}

export default function EditProject() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId)
      .then((data) => {
        setProject(data.project);
        setForm(projectToForm(data.project));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  const set =
    (field: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const value =
        e.target.type === 'checkbox'
          ? (e.target as HTMLInputElement).checked
          : e.target.type === 'number'
          ? parseInt(e.target.value, 10)
          : e.target.value;
      setForm((prev) => prev ? { ...prev, [field]: value } : prev);
    };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || !projectId) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...form,
        allowedDomains: form.allowedDomains
          ? form.allowedDomains.split('\n').map((s) => s.trim()).filter(Boolean)
          : [],
        excludedUrls: form.excludedUrls
          ? form.excludedUrls.split('\n').map((s) => s.trim()).filter(Boolean)
          : [],
        loginUrl: form.loginUrl || undefined,
      };
      await api.updateProject(projectId, payload);
      navigate(`/projects/${projectId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save project');
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" />
      </div>
    );

  if (error && !form) return <div className="text-red-600">{error}</div>;
  if (!form) return null;

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
          <Link to="/projects" className="hover:text-gray-900">Projects</Link>
          <span>/</span>
          <Link to={`/projects/${projectId}`} className="hover:text-gray-900">{form.name}</Link>
          <span>/</span>
          <span className="text-gray-900">Edit</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Edit Project</h1>
        <p className="text-gray-500 text-sm mt-1">Update project settings</p>
      </div>

      <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">{error}</div>
        )}

        <div className="grid gap-6 lg:grid-cols-2 items-start">
          <div className="space-y-6">
            {/* Basic Settings */}
            <div className="card space-y-4">
              <h2 className="font-semibold text-gray-900">Basic Settings</h2>
              <div>
                <label htmlFor="name">Project Name *</label>
                <input id="name" type="text" required value={form.name} onChange={set('name')} />
              </div>
              <div>
                <label htmlFor="baseUrl">Base URL *</label>
                <input id="baseUrl" type="url" required value={form.baseUrl} onChange={set('baseUrl')} />
              </div>
              <div>
                <label htmlFor="crawlDepth">Crawl Depth</label>
                <input id="crawlDepth" type="number" min={1} max={10} value={form.crawlDepth} onChange={set('crawlDepth')} />
                <p className="text-xs text-gray-500 mt-1">How many levels deep to follow links (1–10)</p>
              </div>
            </div>

            {/* Authentication */}
            <div className="card space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-gray-900">Authentication</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    When enabled, a browser will open during the crawl so you can log in manually.
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 text-brand-600 w-4 h-4"
                    checked={form.loginRequired}
                    onChange={set('loginRequired')}
                  />
                  <span className="text-sm font-medium text-gray-700">Login Required</span>
                </label>
              </div>
              {form.loginRequired && (
                <div>
                  <label htmlFor="loginUrl">Login URL</label>
                  <input
                    id="loginUrl"
                    type="url"
                    value={form.loginUrl}
                    onChange={set('loginUrl')}
                    placeholder="https://app.example.com/login (defaults to Base URL)"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Leave blank to use the Base URL as the starting point for login.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            {/* Crawl Options */}
            <div className="card space-y-4">
              <h2 className="font-semibold text-gray-900">Crawl Options</h2>
              <div>
                <label htmlFor="allowedDomains">Allowed Domains (one per line)</label>
                <textarea
                  id="allowedDomains"
                  rows={3}
                  value={form.allowedDomains}
                  onChange={set('allowedDomains')}
                  placeholder="app.example.com&#10;api.example.com"
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Leave blank to auto-detect from Base URL</p>
              </div>
              <div>
                <label htmlFor="excludedUrls">Excluded URLs (one per line)</label>
                <textarea
                  id="excludedUrls"
                  rows={3}
                  value={form.excludedUrls}
                  onChange={set('excludedUrls')}
                  placeholder="/admin/reset&#10;/reports/download"
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 text-brand-600 w-4 h-4"
                    checked={form.screenshotEnabled}
                    onChange={set('screenshotEnabled')}
                  />
                  <span className="text-sm text-gray-700">Capture Screenshots</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 text-brand-600 w-4 h-4"
                    checked={form.networkCaptureEnabled}
                    onChange={set('networkCaptureEnabled')}
                  />
                  <span className="text-sm text-gray-700">Record Network/API Calls</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          <Link to={`/projects/${projectId}`} className="btn-secondary">
            Cancel
          </Link>
          <button
            type="button"
            className="btn-danger ml-auto"
            onClick={() => setShowDeleteModal(true)}
            disabled={!project}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete project
          </button>
        </div>
      </form>

      {showDeleteModal && project && (
        <DeleteConfirmModal
          project={project}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={() => navigate('/projects')}
        />
      )}
    </div>
  );
}
