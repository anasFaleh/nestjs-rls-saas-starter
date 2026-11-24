import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Project } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContext } from '../tenancy/tenant-context.js';
import type { CreateProjectInput, UpdateProjectInput } from './projects.schemas.js';

/**
 * Example tenant-owned resource. Notice what is NOT here: no `where: { tenantId }` anywhere.
 * Every query runs in withCurrentTenant(), and PostgreSQL RLS returns/changes only this tenant's rows.
 * A row of another tenant simply does not exist for this transaction -> 404, never 403 (no existence leak).
 */
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantContext) private readonly tenantContext: TenantContext,
  ) {}

  list(): Promise<Project[]> {
    return this.prisma.withCurrentTenant((tx) => tx.project.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }));
  }

  async get(id: string): Promise<Project> {
    const project = await this.prisma.withCurrentTenant((tx) => tx.project.findUnique({ where: { id } }));
    if (!project) throw new NotFoundException();
    return project;
  }

  create(input: CreateProjectInput): Promise<Project> {
    // tenantId comes from the server-side context. Even if it were wrong, the policy's WITH CHECK would reject the row.
    const tenantId = this.tenantContext.requireTenantId();
    return this.prisma.withCurrentTenant((tx) => tx.project.create({ data: { ...input, tenantId } }));
  }

  update(id: string, input: UpdateProjectInput): Promise<Project> {
    return this.prisma.withCurrentTenant((tx) => tx.project.update({ where: { id }, data: input }));
  }

  async remove(id: string): Promise<void> {
    await this.prisma.withCurrentTenant((tx) => tx.project.delete({ where: { id } }));
  }
}
