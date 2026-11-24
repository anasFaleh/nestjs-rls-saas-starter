import { z } from 'zod';

// `.strict()`: unknown keys are rejected, so a client can never smuggle `tenantId` (or anything else) in.
export const CreateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).nullish(),
  })
  .strict();

export const UpdateProjectSchema = CreateProjectSchema.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
