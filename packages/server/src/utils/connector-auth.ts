import type {
  ConnectorAuthEnvField,
  ConnectorAuthEnvKeys,
  ConnectorAuthMethod,
  ConnectorAuthOAuth,
  ConnectorAuthSchema,
} from '@lobu/connector-sdk';

export type ConnectorAuthOAuthMethod = ConnectorAuthOAuth & {
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  usePkce?: boolean;
  loginScopes?: string[];
  optionalScopes?: string[];
  loginProvisioning?: {
    autoCreateConnection?: boolean;
  };
};

const DEFAULT_AUTH_SCHEMA: ConnectorAuthSchema = {
  methods: [{ type: 'none' }],
};

function isLikelySecretKey(key: string): boolean {
  return /(secret|token|password|api_key|apikey|private_key|client_secret)/i.test(key);
}

function parseLoginProvisioning(
  raw: unknown
): ConnectorAuthOAuthMethod['loginProvisioning'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const result: NonNullable<ConnectorAuthOAuthMethod['loginProvisioning']> = {};
  if (typeof obj.autoCreateConnection === 'boolean') {
    result.autoCreateConnection = obj.autoCreateConnection;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeConnectorAuthSchema(value: unknown): ConnectorAuthSchema {
  if (typeof value === 'string') {
    try {
      return normalizeConnectorAuthSchema(JSON.parse(value));
    } catch {
      return DEFAULT_AUTH_SCHEMA;
    }
  }

  if (!value || typeof value !== 'object') {
    return DEFAULT_AUTH_SCHEMA;
  }

  const rawMethods = (value as { methods?: unknown }).methods;
  if (!Array.isArray(rawMethods) || rawMethods.length === 0) {
    return DEFAULT_AUTH_SCHEMA;
  }

  const methods: ConnectorAuthMethod[] = [];

  for (const rawMethod of rawMethods) {
    if (!rawMethod || typeof rawMethod !== 'object') continue;
    const method = rawMethod as Record<string, unknown>;
    const type = method.type;

    if (type === 'none') {
      methods.push({ type: 'none' });
      continue;
    }

    if (type === 'env_keys') {
      const rawFields = Array.isArray(method.fields) ? method.fields : [];
      const fields: ConnectorAuthEnvField[] = rawFields
        .filter((field) => field && typeof field === 'object')
        .map((field) => {
          const f = field as Record<string, unknown>;
          const key = typeof f.key === 'string' ? f.key.trim() : '';
          return {
            key,
            label: typeof f.label === 'string' ? f.label : undefined,
            description: typeof f.description === 'string' ? f.description : undefined,
            example: typeof f.example === 'string' ? f.example : undefined,
            required: typeof f.required === 'boolean' ? f.required : undefined,
            secret: typeof f.secret === 'boolean' ? f.secret : isLikelySecretKey(key),
          };
        })
        .filter((field) => field.key.length > 0);

      if (fields.length > 0) {
        methods.push({
          type: 'env_keys',
          required: typeof method.required === 'boolean' ? method.required : true,
          scope:
            method.scope === 'connection' || method.scope === 'organization'
              ? method.scope
              : 'connection',
          description: typeof method.description === 'string' ? method.description : undefined,
          fields,
        });
      }
      continue;
    }

    if (type === 'oauth') {
      const provider = typeof method.provider === 'string' ? method.provider.trim() : '';
      if (!provider) continue;

      const requiredScopes = Array.isArray(method.requiredScopes)
        ? method.requiredScopes.filter((scope): scope is string => typeof scope === 'string')
        : [];

      const authParams: Record<string, string> | undefined =
        method.authParams && typeof method.authParams === 'object'
          ? Object.fromEntries(
              Object.entries(method.authParams as Record<string, unknown>).filter(
                ([, value]) => typeof value === 'string'
              ) as Array<[string, string]>
            )
          : undefined;
      const loginScopes = Array.isArray(method.loginScopes)
        ? method.loginScopes.filter((scope): scope is string => typeof scope === 'string')
        : undefined;
      const optionalScopes = Array.isArray(method.optionalScopes)
        ? method.optionalScopes.filter((scope): scope is string => typeof scope === 'string')
        : undefined;
      const loginProvisioning = parseLoginProvisioning(method.loginProvisioning);

      methods.push({
        type: 'oauth',
        provider,
        requiredScopes,
        required: typeof method.required === 'boolean' ? method.required : false,
        scope:
          method.scope === 'connection' || method.scope === 'organization'
            ? method.scope
            : 'connection',
        description: typeof method.description === 'string' ? method.description : undefined,
        authorizationUrl:
          typeof method.authorizationUrl === 'string' ? method.authorizationUrl : undefined,
        tokenUrl: typeof method.tokenUrl === 'string' ? method.tokenUrl : undefined,
        userinfoUrl: typeof method.userinfoUrl === 'string' ? method.userinfoUrl : undefined,
        ...(authParams && Object.keys(authParams).length > 0 ? { authParams } : {}),
        tokenEndpointAuthMethod:
          method.tokenEndpointAuthMethod === 'client_secret_basic' ||
          method.tokenEndpointAuthMethod === 'client_secret_post' ||
          method.tokenEndpointAuthMethod === 'none'
            ? method.tokenEndpointAuthMethod
            : undefined,
        usePkce: typeof method.usePkce === 'boolean' ? method.usePkce : undefined,
        ...(loginScopes && loginScopes.length > 0 ? { loginScopes } : {}),
        ...(optionalScopes && optionalScopes.length > 0 ? { optionalScopes } : {}),
        clientIdKey: typeof method.clientIdKey === 'string' ? method.clientIdKey : undefined,
        clientSecretKey:
          typeof method.clientSecretKey === 'string' ? method.clientSecretKey : undefined,
        setupInstructions:
          typeof method.setupInstructions === 'string' ? method.setupInstructions : undefined,
        ...(loginProvisioning && Object.keys(loginProvisioning).length > 0
          ? { loginProvisioning }
          : {}),
      });
    }
  }

  return methods.length > 0 ? { methods } : DEFAULT_AUTH_SCHEMA;
}

function getEnvAuthMethods(authSchema: ConnectorAuthSchema): ConnectorAuthEnvKeys[] {
  return authSchema.methods.filter(
    (method): method is ConnectorAuthEnvKeys => method.type === 'env_keys'
  );
}

export function getOAuthAuthMethods(authSchema: ConnectorAuthSchema): ConnectorAuthOAuthMethod[] {
  return authSchema.methods.filter(
    (method): method is ConnectorAuthOAuthMethod => method.type === 'oauth'
  );
}

function dedupeAuthFields(fields: ConnectorAuthEnvField[]): ConnectorAuthEnvField[] {
  const seen = new Set<string>();
  const deduped: ConnectorAuthEnvField[] = [];

  for (const field of fields) {
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    deduped.push(field);
  }

  return deduped;
}

export function getRequiredEnvAuthFields(authSchema: ConnectorAuthSchema): ConnectorAuthEnvField[] {
  return dedupeAuthFields(
    getEnvAuthMethods(authSchema)
      .filter((method) => method.required !== false)
      .flatMap((method) => method.fields.filter((field) => field.required !== false))
  );
}
