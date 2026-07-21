import { useState, useEffect } from 'react';
import { Outlet, Link, useLocation, useParams, NavLink } from 'react-router-dom';
import type { Job } from '../types';

function JobStatusBar() {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    const evtSource = new EventSource('/api/events');
    evtSource.addEventListener('job', (e) => {
      const job = JSON.parse(e.data) as Job;
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === job.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = job;
          return next;
        }
        return [job, ...prev].slice(0, 5);
      });
    });
    return () => evtSource.close();
  }, []);

  const activeJobs = jobs.filter((j) => j.status === 'waiting' || j.status === 'active');
  if (activeJobs.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 space-y-2 z-50">
      {activeJobs.map((job) => (
        <div key={job.id} className="card shadow-lg w-72 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-gray-700 capitalize">{job.type}</span>
            <span className="badge badge-blue">{job.status}</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-1.5">
            <div
              className="bg-brand-600 h-1.5 rounded-full transition-all"
              style={{ width: `${job.progress}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">{job.progress.toFixed(0)}%</p>
        </div>
      ))}
    </div>
  );
}

export default function Layout() {
  const location = useLocation();

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
      isActive
        ? 'bg-brand-50 text-brand-700 font-medium'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
    }`;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="shrink-0 z-10 bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <Link to="/projects" className="flex items-center gap-2">
          <img src="/reverseforge-logo.png" alt="ReverseForge AI Studio" className="h-9 w-9 rounded-xl shadow-sm" />
          <span className="font-semibold text-gray-900">ReverseForge AI Studio</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-500">
            v1.0
          </span>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar */}
        <nav className="shrink-0 w-64 bg-white border-r border-gray-200 px-3 py-4 flex flex-col gap-5">
          <SidebarSection title="Workspace">
            <NavLink to="/projects" end className={navLinkClass}>
              <SidebarIcon path="M4 6h16M4 12h16M4 18h16" />
              All Projects
            </NavLink>
            <NavLink to="/projects/new" className={navLinkClass}>
              <SidebarIcon path="M12 5v14m7-7H5" />
              Create Project
            </NavLink>
          </SidebarSection>

          {/* Context-aware project links */}
          {location.pathname.includes('/projects/') && !location.pathname.endsWith('/new') && (
            <ProjectContextLinks />
          )}
        </nav>

        {/* Main content */}
        <main className="flex-1 min-h-0 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>

      <JobStatusBar />
    </div>
  );
}

function SidebarIcon({ path }: { path: string }) {
  return (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
    </svg>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="px-3 pb-1.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function ProjectContextLinks() {
  const { projectId, sessionId } = useParams();
  if (!projectId) return null;

  const parentLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
      isActive
        ? 'bg-brand-50 text-brand-700 font-medium'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
    }`;

  const childLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 rounded-md py-2 pl-8 pr-3 text-sm transition-colors border-l ${
      isActive
        ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
        : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900'
    }`;

  return (
    <>
      <SidebarSection title="Current Project">
        <NavLink to={`/projects/${projectId}`} end className={parentLinkClass}>
          <SidebarIcon path="M3 7h18M5 7v12h14V7M8 11h8M8 15h5" />
          Overview
        </NavLink>
        <NavLink to={`/projects/${projectId}/edit`} className={parentLinkClass}>
          <SidebarIcon path="M11 5H6a2 2 0 0 0-2 2v11h11a2 2 0 0 0 2-2v-5M16 3l5 5-9 9H7v-5l9-9z" />
          Project Settings
        </NavLink>
      </SidebarSection>

      {sessionId && (
        <SidebarSection title="Crawl Evidence">
          <NavLink to={`/projects/${projectId}/crawls/${sessionId}`} end className={parentLinkClass}>
            <SidebarIcon path="M4 5h16v5H4zM4 14h7v5H4zM15 14h5v5h-5z" />
            Crawl Run
          </NavLink>
          <NavLink to={`/projects/${projectId}/crawls/${sessionId}/pages`} className={childLinkClass}>
            Captured Pages
          </NavLink>
          <NavLink to={`/projects/${projectId}/crawls/${sessionId}/api`} className={childLinkClass}>
            API Calls
          </NavLink>
        </SidebarSection>
      )}

      <SidebarSection title="Intelligence & Reports">
        <NavLink to={`/projects/${projectId}/analysis`} className={parentLinkClass}>
          <SidebarIcon path="M4 19V5m0 14h16M8 15l3-4 3 2 4-7" />
          Analysis Graph
        </NavLink>
        <NavLink to={`/projects/${projectId}/reports`} className={parentLinkClass}>
          <SidebarIcon path="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />
          Reports
        </NavLink>
      </SidebarSection>
    </>
  );
}
