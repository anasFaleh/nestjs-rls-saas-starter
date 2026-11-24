import { ArgumentsHost, Catch, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Maps the Prisma errors a client can cause to HTTP errors:
 *  P2025 (record not found; under RLS also "belongs to another tenant") -> 404
 *  P2002 (unique constraint)                                          -> 409
 * Anything else stays a 500 (logged by Nest, no details to the client).
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter {
  override catch(err: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const mapped: HttpException | null =
      err.code === 'P2025'
        ? new NotFoundException()
        : err.code === 'P2002'
          ? new ConflictException('Already exists')
          : null;
    super.catch(mapped ?? err, host);
  }
}
