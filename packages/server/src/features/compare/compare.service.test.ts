import { describe, expect, it, vi } from 'vitest';
import { makeCompareService } from './compare.service';
import { ServiceError, type ActorContext } from '../../platform/contracts/actor';
import type { ConnectionResolver } from '../../platform/connections/resolve';
import type { Permission } from '@foxschema/shared';

/**
 * The point of the service layer: this exercises the real permission gate and
 * the real result shaping with no Express, no HTTP harness, and no database.
 */

// No default for userId: `actor(perms, undefined)` would trigger a default
// parameter and quietly produce a signed-in actor, which is exactly the case
// the 401 test needs to distinguish.
const actor = (perms: Permission[], userId: string | undefined): ActorContext => ({
  userId,
  can: (p) => perms.includes(p),
});
const signedIn = (perms: Permission[]): ActorContext => actor(perms, 'u1');
const anonymous = (perms: Permission[]): ActorContext => actor(perms, undefined);

function fakeResolver(overrides: Partial<ConnectionResolver> = {}): ConnectionResolver {
  return {
    resolveRef: vi.fn(async (_userId, ref) => ({
      dialect: ref.dialect ?? 'postgres',
      option: ref.option ?? {},
      schema: ref.schema ?? 'public',
    })),
    loadScopedTables: vi.fn(async () => ({ tables: [], warnings: [] })),
    ...overrides,
  } as ConnectionResolver;
}

const input = { source: { dialect: 'postgres', option: {} }, target: { dialect: 'mysql', option: {} }, scope: [] };

describe('CompareService', () => {
  it('rejects an actor without schema.compare before touching a database', async () => {
    const resolver = fakeResolver();
    const service = makeCompareService({ resolver });

    await expect(service.compare(input, signedIn(['schema.browse']))).rejects.toMatchObject({
      code: 'forbidden',
    });
    // The gate must run first — no connection resolved, no catalog read.
    expect(resolver.resolveRef).not.toHaveBeenCalled();
    expect(resolver.loadScopedTables).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated actor as 401, not 403', async () => {
    const service = makeCompareService({ resolver: fakeResolver() });
    const err = await service
      .compare(input, anonymous(['schema.compare']))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('unauthenticated');
    expect((err as ServiceError).status).toBe(401);
  });

  it('labels warnings by side so the user can tell which server degraded', async () => {
    const resolver = fakeResolver({
      loadScopedTables: vi
        .fn()
        .mockResolvedValueOnce({ tables: [], warnings: ['roles unreadable'] })
        .mockResolvedValueOnce({ tables: [], warnings: [] }),
    });
    const service = makeCompareService({ resolver });

    const result = await service.compare(input, signedIn(['schema.compare']));
    expect(result.warnings).toEqual(['Source — roles unreadable']);
  });

  it('omits the warnings key entirely when both sides are clean', async () => {
    const service = makeCompareService({ resolver: fakeResolver() });
    const result = await service.compare(input, signedIn(['schema.compare']));
    expect(result).not.toHaveProperty('warnings');
  });

  it('passes each side its own dialect and schema to the compare engine', async () => {
    const resolver = fakeResolver();
    const compareModule = { compare: vi.fn(async () => ({ tables: [] })) };
    const service = makeCompareService({
      resolver,
      compareModule: compareModule as never,
    });

    await service.compare(
      {
        source: { dialect: 'postgres', option: {}, schema: 'src' },
        target: { dialect: 'mysql', option: {}, schema: 'tgt' },
        scope: [],
      },
      signedIn(['schema.compare'])
    );

    expect(compareModule.compare).toHaveBeenCalledWith(
      [],
      [],
      { source: 'postgres', target: 'mysql' },
      { source: 'src', target: 'tgt' }
    );
  });
});
