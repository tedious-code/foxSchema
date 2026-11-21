/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alternateDb2Authentication,
  explainDb2ConnectError,
  materializeDb2CaPem,
  resolveDb2SslConnectionString,
  shouldRetryDb2Authentication,
} from './db2.ssl.js';

describe('resolveDb2SslConnectionString', () => {
  it('leaves the string alone when there is no certificate', () => {
    const cs = 'DATABASE=D;HOSTNAME=h;PORT=50000;Security=SSL;';
    expect(resolveDb2SslConnectionString(cs, { ssl: { enabled: true } })).toBe(cs);
  });

  it('resolves a relative certificate path', () => {
    const cs = 'DATABASE=D;HOSTNAME=h;PORT=50001;Security=SSL;';
    const out = resolveDb2SslConnectionString(cs, {
      ssl: { enabled: true, ca: 'certs/server.arm' },
    });
    expect(out).toContain(`SSLServerCertificate=${path.resolve('certs/server.arm')}`);
  });

  it('writes PEM to a temp file and points SSLServerCertificate at it', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBfoxschema\n-----END CERTIFICATE-----\n';
    const cs = 'DATABASE=D;HOSTNAME=h;PORT=50001;Security=SSL;';
    const out = resolveDb2SslConnectionString(cs, { ssl: { enabled: true, ca: pem } });
    const match = out.match(/SSLServerCertificate=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    const file = match![1]!;
    expect(file.startsWith(os.tmpdir())).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(pem.trim());
    expect(materializeDb2CaPem(pem.trim())).toBe(file);
  });
});

describe('explainDb2ConnectError', () => {
  it('translates SQL0969N on an SSL connect into a handshake hint', () => {
    const err = explainDb2ConnectError(
      new Error(
        '[IBM][CLI Driver] SQL0969N There is no message text corresponding to SQL error "-842216502" in the message file on this workstation. The error was returned from module "SQLJCMN " with original tokens "".'
      ),
      { ssl: { enabled: true } }
    );
    expect(err.message).toContain('TLS handshake');
    expect(err.message).toContain('50001');
    expect(err.message).toContain('.arm');
    expect(err.message).toContain('not a Java .jks');
    expect(err.message).toContain('Original:');
  });

  it('passes through unrelated errors', () => {
    const src = new Error('SQL30081N TCP/IP communication error');
    expect(explainDb2ConnectError(src, { ssl: { enabled: true } })).toBe(src);
  });

  it('translates SQL30082N reason 17 into an authentication hint', () => {
    const err = explainDb2ConnectError(
      new Error(
        '[IBM][CLI Driver] SQL30082N  Security processing failed with reason "17" ("UNSUPPORTED FUNCTION").  SQLSTATE=08001'
      ),
      { ssl: { enabled: false } }
    );
    expect(err.message).toContain('SERVER_ENCRYPT');
    expect(err.message).toContain('not TLS');
  });
});

describe('alternateDb2Authentication', () => {
  it('retries SERVER_ENCRYPT after SERVER', () => {
    expect(shouldRetryDb2Authentication(new Error('SQL30082N reason "17"'))).toBe(true);
    expect(alternateDb2Authentication('A=1;Authentication=SERVER;')).toContain('SERVER_ENCRYPT');
    expect(alternateDb2Authentication('A=1;Authentication=SERVER_ENCRYPT;')).toMatch(
      /Authentication=SERVER;/
    );
  });
});
