/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SMTP client lives in `@foxschema/db/mail`, where the server can use it
 * too (password-reset and invite emails). Re-exported here for the pipes.
 */
export * from '@foxschema/db/mail';
