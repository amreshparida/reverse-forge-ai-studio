import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

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

const defaults: FormState = {
  name: '',
  baseUrl: '',
  loginUrl: '',
  loginRequired: false,
  crawlDepth: 3,
  allowedDomains: '',
  excludedUrls: '',
  screenshotEnabled: true,
  networkCaptureEnabled: true,
};

export default function CreateProject() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(defaults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value =
      e.target.type === 'checkbox'
        ? (e.target as HTMLInputElement).checked
        : e.target.type === 'number'
        ? parseInt(e.target.value, 10)
        : e.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const payload = {
        ...form,
        allowedDomains: form.allowedDomains ? form.allowedDomains.split('\n').map((s) => s.trim()).filter(Boolean) : [],
        excludedUrls: form.excludedUrls ? form.excludedUrls.split('\n').map((s) => s.trim()).filter(Boolean) : [],
        loginUrl: form.loginUrl || undefined,
      };
      const { project } = await api.createProject(payload);
      navigate(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">New Project</h1>
        <p className="text-gray-500 text-sm mt-1">Set up a new reverse engineering project</p>
      </div>

      <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">{error}</div>
        )}

        <div className="grid gap-6 lg:grid-cols-2 items-start">
          <div className="space-y-6">
            <div className="card space-y-4">
              <h2 className="font-semibold text-gray-900">Basic Settings</h2>
              <div>
                <label htmlFor="name">Project Name *</label>
                <input id="name" type="text" required value={form.name} onChange={set('name')} placeholder="My TMS App" />
              </div>
              <div>
                <label htmlFor="baseUrl">Base URL *</label>
                <input id="baseUrl" type="url" required value={form.baseUrl} onChange={set('baseUrl')} placeholder="https://app.example.com" />
              </div>
              <div>
                <label htmlFor="crawlDepth">Crawl Depth</label>
                <input id="crawlDepth" type="number" min={1} max={10} value={form.crawlDepth} onChange={set('crawlDepth')} />
                <p className="text-xs text-gray-500 mt-1">How many levels deep to follow links (1-10)</p>
              </div>
            </div>

            <div className="card space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-gray-900">Authentication</h2>
                  <p className="text-xs text-gray-500 mt-0.5">When enabled, a browser will open during the crawl so you can log in manually.</p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="rounded border-gray-300 text-brand-600 w-4 h-4" checked={form.loginRequired} onChange={set('loginRequired')} />
                  <span className="text-sm font-medium text-gray-700">Login Required</span>
                </label>
              </div>
              {form.loginRequired && (
                <div>
                  <label htmlFor="loginUrl">Login URL</label>
                  <input id="loginUrl" type="url" value={form.loginUrl} onChange={set('loginUrl')} placeholder="https://app.example.com/login (defaults to Base URL)" />
                  <p className="text-xs text-gray-500 mt-1">Leave blank to use the Base URL as the starting point for login.</p>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <div className="card space-y-4">
              <h2 className="font-semibold text-gray-900">Crawl Options</h2>
              <div>
                <label htmlFor="allowedDomains">Allowed Domains (one per line)</label>
                <textarea id="allowedDomains" rows={3} value={form.allowedDomains} onChange={set('allowedDomains')} placeholder="app.example.com&#10;api.example.com" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                <p className="text-xs text-gray-500 mt-1">Leave blank to auto-detect from base URL</p>
              </div>
              <div>
                <label htmlFor="excludedUrls">Excluded URLs (one per line)</label>
                <textarea id="excludedUrls" rows={3} value={form.excludedUrls} onChange={set('excludedUrls')} placeholder="/admin/reset&#10;/reports/download" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="rounded border-gray-300 text-brand-600 w-4 h-4" checked={form.screenshotEnabled} onChange={set('screenshotEnabled')} />
                  <span className="text-sm text-gray-700">Capture Screenshots</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="rounded border-gray-300 text-brand-600 w-4 h-4" checked={form.networkCaptureEnabled} onChange={set('networkCaptureEnabled')} />
                  <span className="text-sm text-gray-700">Record Network/API Calls</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Creating...' : 'Create Project'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/projects')}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
