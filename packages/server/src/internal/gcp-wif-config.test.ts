import { describe, expect, it } from 'vitest';
import {
  assertSafeGcpWifConfig,
  GCP_WIF_TOKEN_FILES_ENV,
  GCP_WIF_TOKEN_URLS_ENV,
} from './gcp-wif-config';

const TOKEN_FILE = '/var/run/secrets/tokens/gcp-ksa/token';
const TOKEN_URL = 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api://x';

const base = {
  type: 'external_account',
  audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x',
  subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  token_url: 'https://sts.googleapis.com/v1/token',
  credential_source: { file: TOKEN_FILE },
};
const env = { [GCP_WIF_TOKEN_FILES_ENV]: TOKEN_FILE, [GCP_WIF_TOKEN_URLS_ENV]: TOKEN_URL };
const check = (over: Record<string, unknown>, e: NodeJS.ProcessEnv = env) => () =>
  assertSafeGcpWifConfig({ ...base, ...over }, e);

describe('assertSafeGcpWifConfig', () => {
  it('accepts a config whose endpoints are Google’s and whose token source is listed', () => {
    expect(check({})).not.toThrow();
    expect(check({ credential_source: { url: TOKEN_URL, headers: { Metadata: 'true' } } })).not.toThrow();
    expect(
      check({
        token_url: 'https://sts.mtls.googleapis.com/v1/token',
        token_info_url: 'https://sts.googleapis.com/v1/introspect',
        service_account_impersonation_url:
          'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken',
        universe_domain: 'googleapis.com',
      })
    ).not.toThrow();
    expect(check({ token_url: 'https://sts.us-east1.rep.googleapis.com/v1/token' })).not.toThrow();
  });

  it('refuses to read the server’s own files and send them out', () => {
    // The attack: any member who may add a secret names a file and a host.
    expect(
      check({ credential_source: { file: '/proc/self/environ' }, token_url: 'https://attacker.example/sts' })
    ).toThrow(/token_url must be https:\/\/sts\.googleapis\.com/);
    // Google's endpoint, but still not a file this install listed.
    expect(check({ credential_source: { file: '/proc/self/environ' } })).toThrow(
      /does not allow reading a subject token from "\/proc\/self\/environ"/
    );
    // A listed file reached through `..` is another file.
    expect(check({ credential_source: { file: `${TOKEN_FILE}/../../../../../../etc/passwd` } })).toThrow(
      /does not allow reading/
    );
    expect(check({ credential_source: { file: 'relative/token' } })).toThrow(/does not allow reading/);
  });

  it('allows nothing until whoever runs the install lists a source', () => {
    expect(check({}, {})).toThrow(new RegExp(GCP_WIF_TOKEN_FILES_ENV));
    expect(check({ credential_source: { url: TOKEN_URL } }, {})).toThrow(new RegExp(GCP_WIF_TOKEN_URLS_ENV));
    // A relative entry in the list allows nothing.
    expect(check({ credential_source: { file: 'token' } }, { [GCP_WIF_TOKEN_FILES_ENV]: 'token' })).toThrow(
      /does not allow reading/
    );
  });

  it('refuses a URL source that is not listed exactly', () => {
    expect(
      check({ credential_source: { url: 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token' } })
    ).toThrow(/does not allow fetching/);
    expect(check({ credential_source: { url: `${TOKEN_URL}&extra=1` } })).toThrow(/does not allow fetching/);
    expect(check({ credential_source: { url: 'not a url' } })).toThrow(/not a URL/);
  });

  it.each([
    ['http, not https', 'http://sts.googleapis.com/v1/token'],
    ['another host', 'https://sts.googleapis.com.attacker.example/v1/token'],
    ['a look-alike Google host', 'https://storage.googleapis.com/v1/token'],
    ['credentials in the URL', 'https://sts.googleapis.com@attacker.example/v1/token'],
    ['another port', 'https://sts.googleapis.com:8443/v1/token'],
    ['another path', 'https://sts.googleapis.com/v1/token/../../upload'],
    ['a query string', 'https://sts.googleapis.com/v1/token?to=attacker'],
    ['a regional host with a dot smuggled in', 'https://sts.a.b.rep.googleapis.com/v1/token'],
    ['nothing', ''],
  ])('refuses a token_url with %s', (_label, token_url) => {
    expect(check({ token_url })).toThrow(/token_url/);
  });

  it('refuses the other endpoints when they are not Google’s', () => {
    expect(check({ token_info_url: 'https://attacker.example/introspect' })).toThrow(/token_info_url/);
    expect(
      check({ service_account_impersonation_url: 'https://attacker.example/v1/projects/-/serviceAccounts/a:generateAccessToken' })
    ).toThrow(/service_account_impersonation_url/);
    expect(
      check({ service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/a/b:signBlob' })
    ).toThrow(/service_account_impersonation_url/);
    expect(check({ universe_domain: 'attacker.example' })).toThrow(/universe_domain/);
  });

  it('refuses sources that use something of the server’s own, listed or not', () => {
    expect(check({ credential_source: { executable: { command: '/bin/sh -c id' } } })).toThrow(/run a program/);
    expect(
      check({ credential_source: { environment_id: 'aws1', regional_cred_verification_url: 'https://sts.us-east-1.amazonaws.com' } })
    ).toThrow(/AWS identity/);
    expect(check({ credential_source: { certificate: { use_default_certificate_config: true } } })).toThrow(
      /certificate/
    );
    expect(check({ credential_source: { file: TOKEN_FILE, url: TOKEN_URL } })).toThrow(/not both/);
    expect(check({ credential_source: {} })).toThrow(/needs a file or a url/);
    expect(check({ credential_source: 'x' })).toThrow(/needs credential_source/);
  });
});
