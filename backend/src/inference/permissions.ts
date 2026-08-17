import { prisma } from '../database/client';
import { config } from '../config';
import { createLLMClient, isLLMConfigured, type LLMConfig } from '../ai/llm';
import { buildPermissionMatrixPrompt } from '../ai/prompts';
import { getSessionAnalyses, getProjectAnalyses, getAnalysesForSessions } from '../ai/analyzer';
import { materializePageAnalysisWorkspace } from '../ai/synthesis-workspace';
import { runSynthesisAgent } from '../ai/synthesis-agent';
import { writeJson } from '../utils/file-system';
import { logger } from '../utils/logger';
import type { Entity } from './entity';
import path from 'path';

export interface RolePermission {
  module: string;
  resource: string;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  approve: boolean;
  import: boolean;
  export: boolean;
  configure: boolean;
}

export interface Role {
  name: string;
  description: string;
  level: 'admin' | 'manager' | 'user' | 'readonly';
  permissions: RolePermission[];
}

export interface PermissionMatrix {
  roles: Role[];
  modules: string[];
}

async function resolveProjectSlug(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { slug: true },
  });
  return project?.slug ?? null;
}

export async function inferPermissions(
  sessionId: string,
  entities: Entity[],
  llmConfig?: LLMConfig,
  appName?: string,
  projectId?: string,
  sourceSessionIds?: string[],
): Promise<PermissionMatrix> {
  const allAnalyses = sourceSessionIds?.length
    ? await getAnalysesForSessions(sourceSessionIds)
    : projectId ? await getProjectAnalyses(projectId) : [];
  const sessionAnalyses = allAnalyses.length > 0 ? allAnalyses : await getSessionAnalyses(sessionId);

  if (isLLMConfigured(llmConfig) && sessionAnalyses.length > 0 && projectId) {
    try {
      if (config.llm.synthesisAgentEnabled) {
        const projectSlug = await resolveProjectSlug(projectId);
        if (!projectSlug) throw new Error('Project slug not found for synthesis workspace');

        const workspace = await materializePageAnalysisWorkspace({
          projectId,
          projectSlug,
          sessionId,
          sourceSessionIds,
        });
        writeJson(path.join(workspace.root, 'entity-model.json'), { entities });

        const { artifact, steps } = await runSynthesisAgent<PermissionMatrix>({
          workspace,
          task: 'permission',
          expectedArtifact: 'permission-matrix.json',
          appName,
          llmConfig,
        });

        if (!artifact.roles || !Array.isArray(artifact.roles)) {
          throw new Error('permission-matrix.json missing roles[]');
        }

        logger.info(`[Permission] Synthesis agent completed in ${steps} steps (${artifact.roles.length} roles)`);
        return normalizePermissionMatrix(artifact, entities);
      }

      const llm = createLLMClient(llmConfig);
      return normalizePermissionMatrix(
        await llm.chatJson<PermissionMatrix>(
          [
            {
              role: 'system',
              content:
                'You are an expert enterprise IAM architect. Generate a role-based permission matrix from web application analysis.',
            },
            {
              role: 'user',
              content: buildPermissionMatrixPrompt(
                sessionAnalyses,
                entities.map((e) => ({ name: e.name, module: e.primaryModule })),
                appName,
              ),
            },
          ],
          { maxTokens: 5000 },
        ),
        entities,
      );
    } catch (err) {
      logger.error('LLM permission inference failed, using fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return generateFallbackPermissions(sessionAnalyses, entities);
}

/** Ensure every role has permissions[] so graph/report code never crashes. */
export function normalizePermissionMatrix(
  raw: PermissionMatrix,
  entities: Entity[] = [],
): PermissionMatrix {
  const modules = Array.isArray(raw.modules)
    ? raw.modules.filter((m) => typeof m === 'string')
    : [...new Set(entities.map((e) => e.primaryModule).filter(Boolean))];

  const roles: Role[] = (Array.isArray(raw.roles) ? raw.roles : []).map((role) => {
    const name = role?.name || 'Unknown';
    const isAdmin = /admin/i.test(name);
    const isManager = /manager|supervisor/i.test(name);
    const isViewer = /viewer|read|auditor|trainee|crew/i.test(name);
    const level = role?.level ?? (isAdmin ? 'admin' : isManager ? 'manager' : isViewer ? 'readonly' : 'user');

    let permissions = Array.isArray(role?.permissions) ? role.permissions : [];
    permissions = permissions.filter((p) => p && typeof p === 'object' && typeof p.resource === 'string');

    if (permissions.length === 0 && entities.length > 0) {
      permissions = entities.map((entity) => ({
        module: entity.primaryModule || 'General',
        resource: entity.name,
        view: true,
        create: !isViewer,
        edit: !isViewer,
        delete: isAdmin,
        approve: isAdmin || isManager,
        import: isAdmin || isManager,
        export: !isViewer,
        configure: isAdmin,
      }));
    }

    return {
      name,
      description: role?.description || `${name} role`,
      level,
      permissions,
    };
  });

  return { roles, modules };
}

function generateFallbackPermissions(
  analyses: Awaited<ReturnType<typeof getSessionAnalyses>>,
  entities: Entity[],
): PermissionMatrix {
  const allRoles = new Set<string>();
  const allModules = new Set<string>();

  for (const analysis of analyses) {
    (analysis.possibleRoles ?? []).forEach((r: string) => allRoles.add(r));
    if (analysis.businessModule) allModules.add(analysis.businessModule);
  }

  if (allRoles.size === 0) {
    ['Admin', 'Manager', 'User', 'Viewer'].forEach((r) => allRoles.add(r));
  }

  const modules = Array.from(allModules);
  const roles: Role[] = Array.from(allRoles).map((roleName) => {
    const isAdmin = /admin/i.test(roleName);
    const isManager = /manager|supervisor/i.test(roleName);
    const isViewer = /viewer|read|auditor/i.test(roleName);

    return {
      name: roleName,
      description: `${roleName} role`,
      level: isAdmin ? 'admin' : isManager ? 'manager' : isViewer ? 'readonly' : 'user',
      permissions: entities.map((entity) => ({
        module: entity.primaryModule || 'General',
        resource: entity.name,
        view: true,
        create: !isViewer,
        edit: !isViewer,
        delete: isAdmin,
        approve: isAdmin || isManager,
        import: isAdmin || isManager,
        export: !isViewer,
        configure: isAdmin,
      })),
    };
  });

  return { roles, modules };
}

export function permissionMatrixToCsv(matrix: PermissionMatrix): string {
  const headers = [
    'Role',
    'Module',
    'Resource',
    'View',
    'Create',
    'Edit',
    'Delete',
    'Approve',
    'Import',
    'Export',
    'Configure',
  ];

  const rows: string[][] = [headers];

  for (const role of matrix.roles) {
    for (const perm of role.permissions ?? []) {
      rows.push([
        role.name,
        perm.module,
        perm.resource,
        perm.view ? 'Y' : 'N',
        perm.create ? 'Y' : 'N',
        perm.edit ? 'Y' : 'N',
        perm.delete ? 'Y' : 'N',
        perm.approve ? 'Y' : 'N',
        perm.import ? 'Y' : 'N',
        perm.export ? 'Y' : 'N',
        perm.configure ? 'Y' : 'N',
      ]);
    }
  }

  return rows.map((r) => r.map((cell) => `"${cell}"`).join(',')).join('\n');
}
