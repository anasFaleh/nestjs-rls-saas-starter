import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CreatedTenant } from '../src/tenancy/tenant-admin.js';
import { issueApiKey, revokeApiKey, setTenantStatus } from '../src/tenancy/tenant-admin.js';
import { createHttpApp, deleteTenants, ownerClient, seedTenants, unique } from './helpers.js';

/** The same isolation, seen from the HTTP API: API key -> tenant -> RLS. */
describe('HTTP API (API key auth + tenant isolation)', () => {
  const owner = ownerClient();
  let app: NestExpressApplication;
  let a: CreatedTenant;
  let b: CreatedTenant;
  const auth = (t: { key: string }) => ({ Authorization: `Bearer ${t.key}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createHttpApp();
    [a, b] = (await seedTenants(owner, 2)) as [CreatedTenant, CreatedTenant];
  });

  afterAll(async () => {
    await deleteTenants(owner, [a, b]);
    await owner.$disconnect();
    await app.close();
  });

  describe('public routes', () => {
    it('GET /healthz and /readyz need no key', async () => {
      await http().get('/healthz').expect(200, { status: 'ok' });
      await http().get('/readyz').expect(200, { status: 'ok' });
    });

    it('no X-Powered-By header', async () => {
      const res = await http().get('/healthz');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('authentication', () => {
    it.each([
      ['no header', {}],
      ['malformed key', { Authorization: 'Bearer nope' }],
      ['wrong scheme', { Authorization: `Basic ${'x'.repeat(10)}` }],
      ['unknown well-formed key', { Authorization: `Bearer sk_${'A'.repeat(43)}` }],
    ])('401 for %s', async (_label, headers) => {
      await http().get('/projects').set(headers).expect(401);
    });

    it('a client-supplied tenant header is ignored: the key decides the tenant', async () => {
      await http()
        .post('/projects')
        .set(auth(a))
        .send({ name: unique('mine') })
        .expect(201);
      const res = await http().get('/projects').set(auth(b)).set('X-Tenant-Id', a.tenantId).expect(200);
      expect(res.body).toEqual([]);
    });

    it('401 after the key is revoked', async () => {
      const k = await issueApiKey(owner, a.tenantId, 'temp');
      await http().get('/projects').set(auth(k)).expect(200);
      expect(await revokeApiKey(owner, a.tenantId, k.keyId)).toBe(true);
      await http().get('/projects').set(auth(k)).expect(401);
    });

    it('401 while the tenant is suspended, 200 again after activation', async () => {
      const [c] = (await seedTenants(owner, 1)) as [CreatedTenant];
      try {
        await setTenantStatus(owner, c.tenantId, 'SUSPENDED');
        await http().get('/projects').set(auth(c)).expect(401);
        await setTenantStatus(owner, c.tenantId, 'ACTIVE');
        await http().get('/projects').set(auth(c)).expect(200);
      } finally {
        await deleteTenants(owner, [c]);
      }
    });
  });

  describe('projects CRUD across tenants', () => {
    let projectOfA: string;

    beforeAll(async () => {
      const res = await http()
        .post('/projects')
        .set(auth(a))
        .send({ name: unique('a-project'), description: 'secret plans' })
        .expect(201);
      projectOfA = res.body.id;
      expect(res.body.tenantId).toBe(a.tenantId);
    });

    it('A reads its project; B gets 404 (not 403: B cannot even learn it exists)', async () => {
      await http().get(`/projects/${projectOfA}`).set(auth(a)).expect(200);
      await http().get(`/projects/${projectOfA}`).set(auth(b)).expect(404);
    });

    it("B's list never contains A's projects", async () => {
      const res = await http().get('/projects').set(auth(b)).expect(200);
      expect(res.body.map((p: { tenantId: string }) => p.tenantId).every((t: string) => t === b.tenantId)).toBe(true);
      expect(res.body.find((p: { id: string }) => p.id === projectOfA)).toBeUndefined();
    });

    it("B cannot update or delete A's project (404), and it is unchanged", async () => {
      await http().patch(`/projects/${projectOfA}`).set(auth(b)).send({ name: 'hacked' }).expect(404);
      await http().delete(`/projects/${projectOfA}`).set(auth(b)).expect(404);
      const res = await http().get(`/projects/${projectOfA}`).set(auth(a)).expect(200);
      expect(res.body.name).not.toBe('hacked');
    });

    it('a body that tries to set tenantId is rejected (400)', async () => {
      await http()
        .post('/projects')
        .set(auth(b))
        .send({ name: unique('evil'), tenantId: a.tenantId })
        .expect(400);
      await http().patch(`/projects/${projectOfA}`).set(auth(a)).send({ tenantId: b.tenantId }).expect(400);
    });

    it('the same name in two tenants is fine; twice in one tenant is 409', async () => {
      const name = unique('shared-name');
      await http().post('/projects').set(auth(a)).send({ name }).expect(201);
      await http().post('/projects').set(auth(b)).send({ name }).expect(201);
      await http().post('/projects').set(auth(a)).send({ name }).expect(409);
    });

    it('validation: 400 for an empty name, a bad id, or an empty patch', async () => {
      await http().post('/projects').set(auth(a)).send({ name: '   ' }).expect(400);
      await http().get('/projects/not-a-uuid').set(auth(a)).expect(400);
      await http().patch(`/projects/${projectOfA}`).set(auth(a)).send({}).expect(400);
    });

    it('A updates and deletes its own project', async () => {
      const created = await http()
        .post('/projects')
        .set(auth(a))
        .send({ name: unique('tmp') })
        .expect(201);
      const renamed = unique('renamed');
      const res = await http().patch(`/projects/${created.body.id}`).set(auth(a)).send({ name: renamed }).expect(200);
      expect(res.body.name).toBe(renamed);
      await http().delete(`/projects/${created.body.id}`).set(auth(a)).expect(204);
      await http().get(`/projects/${created.body.id}`).set(auth(a)).expect(404);
    });
  });
});
