import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TenantContext } from './tenant-context.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';

@Global()
@Module({
  providers: [TenantContext, { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor }],
  exports: [TenantContext],
})
export class TenancyModule {}
