import { useEffect, useMemo, useState, Fragment } from 'react';
import type { ReactNode } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import type { CrawlSession, EntityModel, NetworkCall, PageCapture, WorkflowModel } from '../types';

type TabId = 'overview' | 'entities' | 'workflows' | 'techstack';

interface TechStackData {
  frameworks?: string[];
  cssFramework?: string | null;
  hasJQuery?: boolean;
  hasSPA?: boolean;
  authHints?: string[];
  apiPatterns?: string[];
}

interface RawPage extends PageCapture {
  extractedData?: PageCapture['extractedData'] & {
    techStack?: TechStackData;
    consoleErrors?: Array<{ type: string; text: string }>;
  };
}

function StatCard({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      {detail && <div className="mt-1 text-xs text-gray-500">{detail}</div>}
    </div>
  );
}

export default function AnalysisViewer() {
  const { projectId } = useParams<{ projectId: string }>();
  const [entities, setEntities] = useState<EntityModel[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowModel[]>([]);
  const [sessions, setSessions] = useState<CrawlSession[]>([]);
  const [networkCalls, setNetworkCalls] = useState<NetworkCall[]>([]);
  const [pages, setPages] = useState<RawPage[]>([]);
  const [tab, setTab] = useState<TabId>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const [entityData, workflowData, crawlData, networkData] = await Promise.all([
          api.getEntities(projectId!),
          api.getWorkflows(projectId!),
          api.getCrawls(projectId!),
          api.getNetworkCalls(projectId!, undefined, 1),
        ]);

        const completed = crawlData.sessions.filter((session) => session.status === 'completed');
        const pageSets = await Promise.all(
          completed.slice(0, 8).map((session) =>
            api.getPages(projectId!, session.id, 1, 100).then((data) => data.pages as RawPage[]).catch(() => []),
          ),
        );

        if (cancelled) return;
        setEntities(entityData.entities);
        setWorkflows(workflowData.workflows);
        setSessions(crawlData.sessions);
        setNetworkCalls(networkData.calls);
        setPages(pageSets.flat());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load analysis.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const completedSessions = useMemo(() => sessions.filter((session) => session.status === 'completed'), [sessions]);
  const totalPages = completedSessions.reduce((sum, session) => sum + (session.pagesCount ?? session._count?.pages ?? 0), 0);
  const callsWithPayload = networkCalls.filter((call) => call.requestPayload).length;
  const callsWithResponse = networkCalls.filter((call) => call.responseBody).length;
  const modules = [...new Set(entities.map((entity) => entity.primaryModule).filter(Boolean))] as string[];

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'entities', label: `Entities (${entities.length})` },
    { id: 'workflows', label: `Workflows (${workflows.length})` },
    { id: 'techstack', label: 'Tech Stack' },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-gray-500">
            <Link to={`/projects/${projectId}`} className="hover:text-gray-900">Back to Project</Link>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Analysis Workspace</h1>
          <p className="mt-1 text-sm text-gray-500">
            Project-wide intelligence from completed crawls, captured APIs, inferred entities, workflows, and page evidence.
          </p>
        </div>
        <Link to={`/projects/${projectId}/reports`} className="btn-primary">
          Open Project Report
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Completed Sessions" value={completedSessions.length} detail={`${sessions.length} total sessions`} />
        <StatCard label="Pages Captured" value={totalPages} detail={`${pages.length} pages loaded for inspection`} />
        <StatCard label="API Evidence" value={networkCalls.length} detail={`${callsWithPayload} payloads, ${callsWithResponse} responses`} />
        <StatCard label="Domain Model" value={entities.length} detail={`${workflows.length} workflows, ${modules.length} modules`} />
      </div>

      <div className="flex w-fit gap-1 rounded-lg bg-gray-100 p-1">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === item.id ? 'bg-white text-gray-900 shadow' : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-brand-600" />
        </div>
      ) : tab === 'overview' ? (
        <Overview entities={entities} workflows={workflows} networkCalls={networkCalls} modules={modules} />
      ) : tab === 'entities' ? (
        <EntityList entities={entities} />
      ) : tab === 'workflows' ? (
        <WorkflowList workflows={workflows} />
      ) : (
        <TechStackView pages={pages} />
      )}
    </div>
  );
}

function Overview({
  entities,
  workflows,
  networkCalls,
  modules,
}: {
  entities: EntityModel[];
  workflows: WorkflowModel[];
  networkCalls: NetworkCall[];
  modules: string[];
}) {
  const endpointCount = new Set(networkCalls.map((call) => {
    try {
      const parsed = new URL(call.url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return call.url.split('?')[0];
    }
  })).size;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900">What the analysis currently knows</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <StatCard label="Unique API Endpoints" value={endpointCount} />
            <StatCard label="Fields Inferred" value={entities.reduce((sum, entity) => sum + entity.fields.length, 0)} />
            <StatCard label="Workflow States" value={workflows.reduce((sum, workflow) => sum + workflow.states.length, 0)} />
            <StatCard label="Workflow Transitions" value={workflows.reduce((sum, workflow) => sum + workflow.transitions.length, 0)} />
          </div>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900">Evidence Map</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <EvidenceItem title="Domain" detail="Entities, fields, relationships, modules" active={entities.length > 0} />
            <EvidenceItem title="Workflow" detail="States, transitions, actors, approvals" active={workflows.length > 0} />
            <EvidenceItem title="Integration" detail="Requests, payloads, response bodies, schemas" active={networkCalls.length > 0} />
          </div>
        </div>
      </div>

      <aside className="space-y-4">
        <div className="card">
          <h2 className="font-semibold text-gray-900">Modules</h2>
          {modules.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {modules.map((module) => <span key={module} className="badge badge-blue">{module}</span>)}
            </div>
          ) : (
            <p className="mt-3 text-sm text-gray-500">No modules inferred yet.</p>
          )}
        </div>
        <div className="card">
          <h2 className="font-semibold text-gray-900">Next Step</h2>
          <p className="mt-2 text-sm text-gray-500">
            Use the project report page for the orchestrated, multi-agent report with completeness audit files.
          </p>
        </div>
      </aside>
    </div>
  );
}

function EvidenceItem({ title, detail, active }: { title: string; detail: string; active: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${active ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`}>
      <div className={`text-sm font-semibold ${active ? 'text-emerald-800' : 'text-gray-600'}`}>{title}</div>
      <div className="mt-1 text-xs text-gray-500">{detail}</div>
    </div>
  );
}

function EntityList({ entities }: { entities: EntityModel[] }) {
  if (entities.length === 0) {
    return <div className="card py-12 text-center text-gray-500">No entities found. Run analysis or extract a project report first.</div>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {entities.map((entity) => (
        <div key={entity.id} className="card">
          <div className="mb-2 flex items-start justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">{entity.name}</h3>
              {entity.primaryModule && <span className="badge badge-blue text-xs">{entity.primaryModule}</span>}
            </div>
            <span className="text-xs text-gray-400">{entity.fields.length} fields</span>
          </div>

          {entity.fields.length > 0 && (
            <div className="mt-2">
              <p className="mb-1.5 text-xs font-medium text-gray-500">Fields</p>
              <div className="space-y-1">
                {entity.fields.slice(0, 10).map((field, index) => (
                  <div key={`${field.name}-${index}`} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-gray-700">{field.name}</span>
                    <span className="text-gray-400">/</span>
                    <span className="text-gray-500">{field.type}</span>
                    {field.required && <span className="badge badge-red text-xs" style={{ fontSize: '10px', padding: '1px 4px' }}>required</span>}
                  </div>
                ))}
                {entity.fields.length > 10 && <p className="text-xs text-gray-400">+{entity.fields.length - 10} more</p>}
              </div>
            </div>
          )}

          {entity.relationships.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-medium text-gray-500">Relationships</p>
              <div className="space-y-1">
                {entity.relationships.map((relationship, index) => (
                  <div key={`${relationship.entity}-${index}`} className="text-xs text-gray-600">
                    <span className="text-gray-400">{relationship.type}</span> {'->'} <span className="font-medium">{relationship.entity}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function WorkflowList({ workflows }: { workflows: WorkflowModel[] }) {
  if (workflows.length === 0) {
    return <div className="card py-12 text-center text-gray-500">No workflows found. Run analysis or extract a project report first.</div>;
  }

  return (
    <div className="space-y-4">
      {workflows.map((workflow) => (
        <div key={workflow.id} className="card">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-900">{workflow.name}</h3>
              {workflow.entityName && <span className="text-xs text-gray-500">Entity: {workflow.entityName}</span>}
            </div>
            <span className="badge badge-blue">{workflow.states.length} states</span>
          </div>

          {workflow.states.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1">
              {workflow.states.map((state, index) => (
                <Fragment key={`${state}-${index}`}>
                  <span className="badge badge-gray">{state}</span>
                  {index < workflow.states.length - 1 && <span className="text-sm text-gray-400">{'->'}</span>}
                </Fragment>
              ))}
            </div>
          )}

          {workflow.actors.length > 0 && <div className="text-xs text-gray-500">Actors: {workflow.actors.join(', ')}</div>}

          {workflow.transitions.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="text-xs">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>Trigger</th>
                    <th>Actor</th>
                    <th>Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {workflow.transitions.map((transition, index) => (
                    <tr key={index}>
                      <td>{transition.from}</td>
                      <td>{transition.to}</td>
                      <td>{transition.trigger}</td>
                      <td>{transition.actor}</td>
                      <td>{transition.approvalRequired ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TechStackView({ pages }: { pages: RawPage[] }) {
  const stacks = pages.map((page) => page.extractedData?.techStack).filter(Boolean) as TechStackData[];
  const consoleErrors = pages.flatMap((page) =>
    (page.extractedData?.consoleErrors ?? []).map((entry) => ({ ...entry, page: page.url })),
  );

  const frameworks = [...new Set(stacks.flatMap((stack) => stack.frameworks ?? []))];
  const css = [...new Set(stacks.map((stack) => stack.cssFramework).filter(Boolean))] as string[];
  const auth = [...new Set(stacks.flatMap((stack) => stack.authHints ?? []))];
  const apiPatterns = [...new Set(stacks.flatMap((stack) => stack.apiPatterns ?? []))];
  const isSPA = stacks.some((stack) => stack.hasSPA);
  const usesJQuery = stacks.some((stack) => stack.hasJQuery);

  if (stacks.length === 0 && consoleErrors.length === 0) {
    return <div className="card py-10 text-center text-sm text-gray-500">No tech stack data found in the loaded project pages.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <TechCard title="Frameworks">
          {frameworks.length > 0 || isSPA || usesJQuery ? (
            <div className="flex flex-wrap gap-1.5">
              {frameworks.map((framework) => <span key={framework} className="badge badge-blue">{framework}</span>)}
              {isSPA && <span className="badge badge-green">SPA</span>}
              {usesJQuery && <span className="badge badge-gray">jQuery</span>}
            </div>
          ) : <p className="text-sm text-gray-500">Not detected</p>}
        </TechCard>
        <TechCard title="CSS / UI Library">
          {css.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">{css.map((item) => <span key={item} className="badge badge-blue">{item}</span>)}</div>
          ) : <p className="text-sm text-gray-500">Not detected</p>}
        </TechCard>
        <TechCard title="API Patterns">
          {apiPatterns.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">{apiPatterns.map((item) => <span key={item} className="badge badge-green">{item}</span>)}</div>
          ) : <p className="text-sm text-gray-500">Not detected</p>}
        </TechCard>
      </div>

      {auth.length > 0 && (
        <div className="card">
          <h3 className="mb-3 font-semibold text-gray-900">Auth Signals</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {auth.slice(0, 12).map((hint) => <code key={hint} className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700">{hint}</code>)}
          </div>
        </div>
      )}

      {consoleErrors.length > 0 && (
        <div className="card">
          <h3 className="mb-3 font-semibold text-gray-900">Console Errors and Warnings ({consoleErrors.length})</h3>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {consoleErrors.slice(0, 60).map((entry, index) => (
              <div key={index} className={`rounded-lg p-2 text-xs ${entry.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-yellow-50 text-yellow-700'}`}>
                <span className="font-medium capitalize">{entry.type}:</span> {entry.text}
                <div className="mt-0.5 truncate text-gray-400">on {entry.page}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TechCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h3 className="mb-2 font-semibold text-gray-900">{title}</h3>
      {children}
    </div>
  );
}
