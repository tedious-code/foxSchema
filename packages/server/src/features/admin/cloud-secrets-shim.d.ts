/** Ambient types for optional cloud secret SDKs (lazy-imported at runtime). */

declare module '@aws-sdk/client-secrets-manager' {
  export class SecretsManagerClient {
    constructor(config?: {
      region?: string;
      credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };
    });
    send(command: unknown): Promise<{
      SecretString?: string;
      SecretBinary?: Uint8Array;
    }>;
  }
  export class GetSecretValueCommand {
    constructor(input: { SecretId: string; VersionId?: string });
  }
}

declare module 'google-auth-library' {
  export class IdentityPoolClient {
    constructor(opts: Record<string, unknown>);
    getAccessToken(): Promise<string | { token?: string | null } | null | undefined>;
  }
  export class GoogleAuth {
    constructor(opts: { credentials?: Record<string, unknown>; scopes?: string[] });
    getClient(): Promise<IdentityPoolClient>;
  }
}

declare module '@google-cloud/secret-manager' {
  export class SecretManagerServiceClient {
    constructor(config?: {
      credentials?: object;
      authClient?: unknown;
      apiEndpoint?: string;
    });
    accessSecretVersion(req: { name: string }): Promise<
      [{ payload?: { data?: string | Uint8Array } }]
    >;
  }
}

declare module '@azure/keyvault-secrets' {
  export class SecretClient {
    constructor(vaultUrl: string, credential: unknown);
    getSecret(
      name: string,
      options?: { version?: string }
    ): Promise<{ value?: string }>;
  }
}

declare module '@azure/identity' {
  export class DefaultAzureCredential {
    constructor();
  }
  export class ClientSecretCredential {
    constructor(tenantId: string, clientId: string, clientSecret: string);
  }
}
