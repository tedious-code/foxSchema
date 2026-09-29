/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contracts shared by the frontend, the server and the CLI.
 *
 * What belongs here is anything two of those three must agree on to talk to
 * each other: permission names, error codes, wire message shapes. What does not
 * belong here is behaviour — no database access, no HTTP, no Node built-ins.
 * Browser code imports this package, so a Node import would break the Vite
 * build; `purity.test.ts` enforces that rather than trusting review.
 */
export * from './permissions';
export * from './errors';
export * from './server-beam';
export * from './lokee-wire';
export * from './nav';
export * from './password-policy';
