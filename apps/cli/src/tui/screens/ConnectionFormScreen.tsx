import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import {
  authMethodsForDialect,
  buildConnectionString,
  dialectOffersAuthMethods,
  parseWindowsAccount,
  passwordFieldLabel,
  resolveAuthMethod,
  type ConnectionOptions,
} from '@foxschema/db';
import { getContext } from '../../runtime/store';
import { friendlyError } from '../../format/friendlyError';
import { KeyHints } from '../components/KeyHints';
import type { ConnRef, Role } from '../types';

interface Props {
  role: Role;
  onSubmit: (ref: ConnRef) => void;
}

interface FieldStep {
  key: 'name' | 'dialect' | 'authMethod' | 'domain' | 'host' | 'port' | 'database' | 'user' | 'schema';
  label: string;
  default?: string;
}

type Values = Partial<Record<FieldStep['key'], string>>;

function fieldsFor(values: Values): FieldStep[] {
  const dialect = (values.dialect || 'postgres').trim().toLowerCase();
  const method = resolveAuthMethod(dialect, values.authMethod);
  const fields: FieldStep[] = [
    { key: 'name', label: 'Connection name (for saving later)' },
    { key: 'dialect', label: 'Dialect (postgres/mysql/mariadb/sqlserver/oracle/db2)', default: 'postgres' },
  ];
  if (dialectOffersAuthMethods(dialect)) {
    fields.push({
      key: 'authMethod',
      label: `Login method (${authMethodsForDialect(dialect)
        .map((m) => m.value)
        .join('/')})`,
      default: 'password',
    });
  }
  if (method === 'windows') {
    fields.push({ key: 'domain', label: 'Domain (blank if username is DOMAIN\\user)' });
  }
  fields.push(
    { key: 'host', label: 'Host' },
    { key: 'port', label: 'Port (blank for default)' },
    { key: 'database', label: 'Database' },
    { key: 'user', label: 'Username' },
    { key: 'schema', label: 'Schema (blank if none)' }
  );
  return fields;
}

/** Mirrors commands/connections.ts's addConnection field set, walked one field per screen since ink-text-input is single-line. */
export function ConnectionFormScreen({ role, onSubmit }: Props): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Values>({});
  const [current, setCurrent] = useState('');
  const [passwordStep, setPasswordStep] = useState(false);
  const [password, setPassword] = useState('');
  const [saveStep, setSaveStep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const fields = fieldsFor(values);
  const field = fields[step];
  const loginMethod = resolveAuthMethod(values.dialect || 'postgres', values.authMethod);

  const finish = async (shouldSave: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const dialect = values.dialect || 'postgres';
      const authMethod = resolveAuthMethod(dialect, values.authMethod);
      if (authMethod === 'windows') {
        const account = parseWindowsAccount(values.user, values.domain);
        if (!account.domain || !account.userName) {
          throw new Error(
            'Windows login needs a domain and a user (CONTOSO\\alice, or Domain + User). UPN (user@domain) is not NTLM.'
          );
        }
      }
      const option: ConnectionOptions = {
        host: values.host || undefined,
        port: values.port ? Number(values.port) : undefined,
        database: values.database || undefined,
        username: values.user || undefined,
        password: password || undefined,
        schema: values.schema || undefined,
        authMethod: authMethod === 'password' ? undefined : authMethod,
        domain: authMethod === 'windows' ? values.domain?.trim() || undefined : undefined,
      };
      option.connectionString = buildConnectionString(dialect, option);

      if (shouldSave) {
        const ctx = await getContext();
        await ctx.connections.create(ctx.scope, {
          name: values.name,
          dialect,
          schema: values.schema || undefined,
          option,
        });
      }

      onSubmit({ dialect, option, schema: values.schema || '', label: values.name || dialect });
    } catch (e) {
      setBusy(false);
      setError(friendlyError(e));
    }
  };

  if (busy) {
    return (
      <Box paddingX={1}>
        <Text>
          <Spinner type="dots" /> Connecting…
        </Text>
      </Box>
    );
  }

  if (saveStep) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Save this connection for next time?</Text>
        {error && <Text color="red">{error}</Text>}
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: 'Yes, save it', value: 'yes' },
              { label: 'No, use it just for this session', value: 'no' },
            ]}
            onSelect={(item) => finish(item.value === 'yes')}
          />
        </Box>
        <KeyHints hints={['↑↓ navigate', 'enter choose', 'esc back']} />
      </Box>
    );
  }

  if (passwordStep) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>
          New <Text color="cyan">{role}</Text> connection — {passwordFieldLabel(loginMethod)}
        </Text>
        {error && <Text color="red">{error}</Text>}
        <Box marginTop={1}>
          <Text>{passwordFieldLabel(loginMethod)}: </Text>
          <TextInput value={password} onChange={setPassword} onSubmit={() => setSaveStep(true)} mask="*" />
        </Box>
        <KeyHints hints={['enter continue', 'esc back']} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        New <Text color="cyan">{role}</Text> connection — {field.label}
      </Text>
      {error && <Text color="red">{error}</Text>}
      <Box marginTop={1}>
        <Text>{field.label}: </Text>
        <TextInput
          value={current}
          onChange={setCurrent}
          onSubmit={(value) => {
            let v = value.trim() || field.default || '';
            if (field.key === 'authMethod') {
              v = resolveAuthMethod(values.dialect || 'postgres', v);
            }
            const nextValues = { ...values, [field.key]: v };
            setValues(nextValues);
            setCurrent('');
            const nextFields = fieldsFor(nextValues);
            if (step + 1 < nextFields.length) {
              setStep(step + 1);
            } else {
              setPasswordStep(true);
            }
          }}
        />
      </Box>
      <KeyHints hints={['enter next field', 'esc back']} />
    </Box>
  );
}
