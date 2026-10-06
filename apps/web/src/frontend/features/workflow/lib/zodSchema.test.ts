import { describe, expect, it } from 'vitest';
import { compileZodSchema } from './zodSchema';

describe('compileZodSchema', () => {
  it('compiles an expression or a returning body to draft-7 JSON Schema', async () => {
    const expr = await compileZodSchema('z.object({ id: z.number(), name: z.string().optional() })');
    expect(expr).toMatchObject({
      schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    });
    const body = await compileZodSchema('const id = z.string();\nreturn z.object({ id });');
    expect(body).toMatchObject({ schema: { properties: { id: { type: 'string' } } } });
  });

  it('reports code that does not compile, and treats empty code as no schema', async () => {
    expect(await compileZodSchema('z.object({')).toHaveProperty('error');
    expect(await compileZodSchema('   ')).toBeNull();
  });

  it('answers in the order it was asked, empty code included', async () => {
    const order: string[] = [];
    await Promise.all([
      compileZodSchema('z.string()').then(() => order.push('typed')),
      compileZodSchema('').then(() => order.push('cleared')),
    ]);
    expect(order).toEqual(['typed', 'cleared']);
  });
});
