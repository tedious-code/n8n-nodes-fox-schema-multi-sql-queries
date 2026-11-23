import {
	NodeOperationError,
	sleep,
	type ICredentialDataDecryptedObject,
	type INode,
} from 'n8n-workflow';
import {
	ConnectionFactory,
	DEFAULT_PORTS,
	dialectSupportsTransactionalRollback,
	getAdapter,
	getRegisteredProvider,
} from './foxSchema';
import {
	assertSupportedDialect,
	DEFAULT_SCHEMA,
	isFileDialect,
	isMysqlFamily,
	type SupportedDialect,
} from './supportedDialects';
import type { DatabaseConnectionConfig, ResolvedConnection } from './types';

export function defaultPort(dialect: SupportedDialect): number {
	return DEFAULT_PORTS[dialect] ?? 5432;
}

export function resolveDialect(rawDialect: unknown): SupportedDialect {
	return assertSupportedDialect(String(rawDialect ?? 'postgres'));
}

export function resolveSchemaFromConfig(
	config: Record<string, any>,
	dialect: SupportedDialect,
): string {
	const schema = String(config.schema ?? '').trim();
	if (schema) return schema;
	if (isMysqlFamily(dialect) || dialect === 'clickhouse') {
		return String(config.database ?? '').trim();
	}
	if (dialect === 'oracle') {
		return String(config.username ?? '').trim().toUpperCase();
	}
	return DEFAULT_SCHEMA[dialect];
}

export function toResolvedConnection(
	config: Record<string, any>,
	timeoutMs?: number,
	labelOverride?: string,
	node?: INode,
): ResolvedConnection {
	const dialect = resolveDialect(config.dialect);
	const connectionString = String(config.connectionString ?? '').trim();
	const database = String(config.database ?? '').trim();

	if (isFileDialect(dialect) && !database && !connectionString) {
		const msg = `Dialect "${dialect}" needs a database file path (for example /data/app.db) or connectionString.`;
		if (node) {
			throw new NodeOperationError(node, msg);
		}
		throw new NodeOperationError(
			{
				id: 'fox-schema-multi-sql',
				name: 'Fox Schema Multi SQL Queries',
				type: 'foxSchemaMultiSqlQueries',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			},
			msg,
		);
	}

	const options: Record<string, unknown> = {
		database,
		username: String(config.username ?? ''),
		password: String(config.password ?? ''),
		schema: resolveSchemaFromConfig(config, dialect),
	};

	if (connectionString) {
		options.connectionString = connectionString;
	}

	if (!isFileDialect(dialect)) {
		options.host = String(config.host ?? 'localhost');
		options.port = Number(config.port || defaultPort(dialect));
		options.ssl = {
			enabled: Boolean(config.useSsl) || dialect === 'azuresql',
			rejectUnauthorized: config.rejectUnauthorized !== false,
		};
	}

	if (timeoutMs !== undefined && timeoutMs > 0) {
		options.timeout = {
			connectMs: timeoutMs,
			queryMs: timeoutMs,
		};
	}

	const label =
		labelOverride ||
		(isFileDialect(dialect)
			? `${dialect}:${database || connectionString}`
			: `${dialect}:${options.host}:${options.port}/${database}`);

	return {
		dialect,
		label,
		options,
	};
}

export function extractVaultMap(
	vaultCredentials: ICredentialDataDecryptedObject | undefined,
): Map<string, DatabaseConnectionConfig> {
	const map = new Map<string, DatabaseConnectionConfig>();
	const rawList = (vaultCredentials?.connections as any)?.connectionValues;
	if (!Array.isArray(rawList)) return map;

	for (const entry of rawList) {
		const alias = String(entry?.alias ?? '').trim();
		if (!alias) continue;
		map.set(alias, {
			alias,
			dialect: String(entry.dialect ?? 'postgres'),
			connectionString: entry.connectionString,
			host: entry.host,
			port: entry.port,
			database: entry.database,
			username: entry.username,
			password: entry.password,
			schema: entry.schema,
			useSsl: entry.useSsl,
			rejectUnauthorized: entry.rejectUnauthorized,
		});
	}
	return map;
}

export interface ManagedDbHandle {
	dialect: SupportedDialect;
	query: (sql: string, params?: any[]) => Promise<any[]>;
	beginTransaction: () => Promise<void>;
	commitTransaction: () => Promise<void>;
	rollbackTransaction: () => Promise<void>;
	close: () => Promise<void>;
}

export async function openManagedHandle(
	resolved: ResolvedConnection,
	node: INode,
	opts: { pooled?: boolean } = {},
): Promise<ManagedDbHandle> {
	const { dialect, options } = resolved;
	const connection = await ConnectionFactory.create(dialect, options, opts);
	const adapter = getAdapter(dialect);
	let inTransaction = false;
	let closed = false;

	return {
		dialect,
		async query(sql: string, params: any[] = []) {
			if (closed) {
				throw new NodeOperationError(
					node,
					`This ${dialect} connection is already closed.`,
				);
			}
			const rows = ((await adapter.query(connection, sql, params)) ?? []) as any[];
			if (dialect === 'oracle' && !inTransaction) {
				await adapter.commitTransaction(connection);
			}
			return rows;
		},
		async beginTransaction() {
			if (!dialectSupportsTransactionalRollback(dialect)) {
				throw new NodeOperationError(
					node,
					`Dialect "${dialect}" does not support transactional rollback.`,
				);
			}
			inTransaction = true;
			await adapter.beginTransaction(connection);
		},
		async commitTransaction() {
			await adapter.commitTransaction(connection);
			inTransaction = false;
		},
		async rollbackTransaction() {
			try {
				await adapter.rollbackTransaction(connection);
			} finally {
				inTransaction = false;
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			await ConnectionFactory.close(dialect, connection);
		},
	};
}

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
	node: INode,
	onTimeout?: () => void,
): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return promise;
	}

	const controller = new AbortController();
	const timeoutPromise = sleep(timeoutMs, controller.signal).then(() => {
		try {
			onTimeout?.();
		} catch {
			// Ignore cleanup errors during timeout rejection
		}
		throw new NodeOperationError(node, `${label} timed out after ${timeoutMs}ms`);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		controller.abort();
		await timeoutPromise.catch(() => undefined);
	}
}

export async function testSingleConnection(
	credentials: ICredentialDataDecryptedObject,
): Promise<{ ok: true } | { ok: false; message: string }> {
	try {
		const resolved = toResolvedConnection(credentials);
		const provider = getRegisteredProvider(resolved.dialect);
		await provider.testConnection(resolved.options);
		return { ok: true };
	} catch (err: any) {
		return { ok: false, message: err?.message || String(err) };
	}
}

export async function testVaultConnections(
	vaultCredentials: ICredentialDataDecryptedObject,
): Promise<
	| { ok: true; testedCount: number; aliases: string[] }
	| { ok: false; message: string }
> {
	const vaultMap = extractVaultMap(vaultCredentials);
	if (vaultMap.size === 0) {
		return {
			ok: false,
			message:
				'At least one database connection must be added to the Multi-DB Vault.',
		};
	}
	const aliases: string[] = [];
	for (const [alias, config] of vaultMap.entries()) {
		try {
			const resolved = toResolvedConnection(config, 10_000, alias);
			const provider = getRegisteredProvider(resolved.dialect);
			await provider.testConnection(resolved.options);
			aliases.push(alias);
		} catch (err: any) {
			return {
				ok: false,
				message: `Connection "${alias}" (${config.dialect}) failed: ${err?.message || err}`,
			};
		}
	}
	return { ok: true, testedCount: aliases.length, aliases };
}
