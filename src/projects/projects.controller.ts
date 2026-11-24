import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Project } from '../generated/prisma/client.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from './projects.schemas.js';
import { ProjectsService } from './projects.service.js';

/** Protected by the global ApiKeyGuard; runs inside the tenant context set by TenantContextInterceptor. */
@Controller('projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get()
  list(): Promise<Project[]> {
    return this.projects.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Project> {
    return this.projects.get(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(CreateProjectSchema)) body: CreateProjectInput): Promise<Project> {
    return this.projects.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateProjectSchema)) body: UpdateProjectInput,
  ): Promise<Project> {
    return this.projects.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.projects.remove(id);
  }
}
