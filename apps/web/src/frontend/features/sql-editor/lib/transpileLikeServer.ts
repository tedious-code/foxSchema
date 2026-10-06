/**
 * For tests only: compiles a TypeScript cell the way the server's
 * POST /sql/code-cell/transpile does (code-cell-execute.service.ts
 * `transpileTs`), so unit tests can run TypeScript cells without a server.
 * Test files mock `transpileCodeCell` from '@/shared/api/sqlApi' with it; no
 * app code imports it, so it never reaches the bundle.
 */
export async function transpileLikeServer(source: string): Promise<string> {
  const ts = await import('typescript');
  const out = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, strict: false },
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; '));
  }
  return out.outputText;
}
