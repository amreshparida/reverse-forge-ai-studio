const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const apiToken = typeof window !== 'undefined'
    ? window.sessionStorage.getItem('reverseforge-api-token')
    : null;
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  // Projects
  getProjects: () => request<{ projects: import('../types').Project[] }>('/projects'),
  getProject: (id: string) => request<{ project: import('../types').Project }>(`/projects/${id}`),
  createProject: (data: unknown) =>
    request<{ project: import('../types').Project }>('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateProject: (id: string, data: unknown) =>
    request<{ project: import('../types').Project }>(`/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteProject: (id: string, confirmName: string) =>
    request<{ success: boolean; deletedPaths?: string[] }>(`/projects/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmName }),
    }),
  cloneProject: (id: string, data?: { name?: string }) =>
    request<{ project: import('../types').Project }>(`/projects/${id}/clone`, {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),

  // Crawls
  getCrawls: (projectId: string) =>
    request<{ sessions: import('../types').CrawlSession[] }>(`/projects/${projectId}/crawls`),
  startCrawl: (projectId: string) =>
    request<{ session: import('../types').CrawlSession }>(`/projects/${projectId}/crawls`, { method: 'POST' }),
  startAgentCrawl: (projectId: string) =>
    request<{ session: import('../types').CrawlSession; mode: string }>(`/projects/${projectId}/crawls/agent`, { method: 'POST' }),
  startCollaborativeCrawl: (projectId: string) =>
    request<{ session: import('../types').CrawlSession; mode: string }>(`/projects/${projectId}/crawls/collaborative`, { method: 'POST' }),
  startManualCrawl: (projectId: string) =>
    request<{ session: import('../types').CrawlSession; mode: string }>(`/projects/${projectId}/crawls/manual`, { method: 'POST' }),
  getCrawl: (projectId: string, sessionId: string) =>
    request<{ session: import('../types').CrawlSession; job: import('../types').Job | null }>(
      `/projects/${projectId}/crawls/${sessionId}`,
    ),
  getCrawlLogs: (projectId: string, sessionId: string, afterId = 0) =>
    request<{ logs: import('../types').CrawlLogEntry[] }>(
      `/projects/${projectId}/crawls/${sessionId}/logs?afterId=${afterId}`,
    ),
  stopCrawl: (projectId: string, sessionId: string) =>
    request<{ success: boolean }>(`/projects/${projectId}/crawls/${sessionId}/stop`, { method: 'POST' }),
  markCrawlComplete: (projectId: string, sessionId: string) =>
    request<{ session: import('../types').CrawlSession }>(
      `/projects/${projectId}/crawls/${sessionId}/mark-complete`,
      { method: 'POST' },
    ),
  deleteSession: (projectId: string, sessionId: string, confirmId: string) =>
    request<{ success: boolean; deletedPaths?: string[] }>(`/projects/${projectId}/crawls/${sessionId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmId }),
    }),
  startAnalysis: (projectId: string, sessionId: string) =>
    request<{ message: string }>(`/projects/${projectId}/crawls/${sessionId}/analyze`, { method: 'POST' }),
  generateReport: (projectId: string, sessionId: string) =>
    request<{ message: string; jobId?: string }>(`/projects/${projectId}/crawls/${sessionId}/generate-report`, { method: 'POST' }),
  generateProjectReport: (projectId: string) =>
    request<{ message: string; jobId?: string }>(`/projects/${projectId}/crawls/generate-report`, { method: 'POST' }),
  resumeProjectReport: (projectId: string) =>
    request<{ message: string; jobId?: string; resumeFrom?: string | null; completedStages?: string[] }>(
      `/projects/${projectId}/crawls/resume-report`,
      { method: 'POST' },
    ),
  getGenerationStatus: (projectId: string) =>
    request<import('../types').GenerationProgress>(`/projects/${projectId}/crawls/generation-status`),

  // Pages
  getPages: (projectId: string, sessionId: string, page = 1, limit = 50) =>
    request<{
      pages: import('../types').PageCapture[];
      total: number;
    }>(`/projects/${projectId}/crawls/${sessionId}/pages?page=${page}&limit=${limit}`),
  getPage: (projectId: string, sessionId: string, pageId: string) =>
    request<{ page: import('../types').PageCapture }>(
      `/projects/${projectId}/crawls/${sessionId}/pages/${pageId}`,
    ),

  // Analysis
  getEntities: (projectId: string) =>
    request<{ entities: import('../types').EntityModel[] }>(`/projects/${projectId}/analysis/entities`),
  getWorkflows: (projectId: string) =>
    request<{ workflows: import('../types').WorkflowModel[] }>(`/projects/${projectId}/analysis/workflows`),
  getNetworkCalls: (projectId: string, sessionId?: string, page = 1) =>
    request<{ calls: import('../types').NetworkCall[]; total: number }>(
      `/projects/${projectId}/analysis/network?page=${page}${sessionId ? `&sessionId=${sessionId}` : ''}`,
    ),
  getJobs: (projectId: string) =>
    request<{ jobs: import('../types').Job[] }>(`/projects/${projectId}/analysis/jobs`),

  // Reports
  getReports: (projectId: string) =>
    request<{ reports: import('../types').Report[] }>(`/projects/${projectId}/reports`),
  getLatestReportPreview: (projectId: string) =>
    request<{ content: string; path: string; report: import('../types').Report; sessionId: string }>(
      `/projects/${projectId}/reports/preview/latest`,
    ),
  getReportPreview: (projectId: string, sessionId: string) =>
    request<{ content: string; path: string }>(`/projects/${projectId}/reports/preview/${sessionId}`),
  downloadReport: (reportId: string, projectId: string) =>
    `/api/projects/${projectId}/reports/${reportId}/download`,
  exportLatestReport: (projectId: string) =>
    `/api/projects/${projectId}/reports/export/latest`,
  exportSession: (projectId: string, sessionId: string) =>
    `/api/projects/${projectId}/reports/export/${sessionId}`,

  // Evidence upload
  uploadEvidence: (projectId: string, files: File[]) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    const apiToken = typeof window !== 'undefined'
      ? window.sessionStorage.getItem('reverseforge-api-token')
      : null;
    return fetch(`${BASE_URL}/projects/${projectId}/evidence/upload`, {
      method: 'POST',
      headers: {
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      },
      body: formData,
    }).then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{
        session: import('../types').CrawlSession;
        jobId: string;
        message: string;
      }>;
    });
  },
};
