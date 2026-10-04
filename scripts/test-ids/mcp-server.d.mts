/** Types for mcp-server.mjs, for the tests that import it. */
import type { TestIdCatalog, TestIdEntry } from './extract-test-ids.mjs';

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
export function findTestIds(catalog: TestIdCatalog, query: string, limit?: number): TestIdEntry[];
export function describeScreen(catalog: TestIdCatalog, name: string): string;
export function scaffoldTest(catalog: TestIdCatalog, args: { component: string; flow?: string }): string;
export function handleMessage(msg: JsonRpcMessage): JsonRpcResponse | null;
