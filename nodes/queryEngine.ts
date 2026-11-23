import {
	NodeOperationError,
	sleep,
	type ICredentialDataDecryptedObject,
	type INode,
} from 'n8n-workflow';
import {
	extractVaultMap,
	openManagedHandle,
	toResolvedConnection,
	withTimeout,
	type ManagedDbHandle,
} from './dbConnection';
import { extractByPath, interpolateSqlExpressions } from './expressionResolver';
import { buildSqlAndBindings } from './sqlBinding';
import type {
	CredentialScope,
	ExecutionMode,
	GlobalSqlSettings,
	ResolvedConnection,
	SqlPipelineContext,
	SqlQueryDefinition,
	SqlStepExecutionResult,
} from './types';

export interface ConnectionResolutionInput {
	credentialScope: CredentialScope;
	singleCredential?: ICredentialDataDecryptedObject;
	vaultCredential?: ICredentialDataDecryptedObject;
}

export function resolveQueryConnection(
	query: SqlQueryDefinition,
	input: ConnectionResolutionInput,
	timeoutMs: number,
	node: INode,
): ResolvedConnection {
	const vaultMap = extractVaultMap(input.vaultCredential);

	let source = query.connectionSource;
	if (input.credentialScope === 'single') {
		source = 'defaultCredential';
	} else if (input.credentialScope === 'multiVault') {
		source = 'vaultAlias';
	} else if (input.credentialScope === 'perQuery') {
		source = 'inline';
	}

	if (source === 'defaultCredential') {
		if (!input.singleCredential) {
			throw new NodeOperationError(
				node,
				`Query "${query.alias}" requires the "Fox Schema SQL Database API" credential.`,
			);
		}
		return toResolvedConnection(input.singleCredential, timeoutMs, 'default', node);
	}

	if (source === 'vaultAlias') {
		const alias = String(query.vaultAlias ?? '').trim();
		if (!alias) {
			throw new NodeOperationError(
				node,
				`Query "${query.alias}" must specify a Multi-DB Vault Connection Alias.`,
			);
		}
		const config = vaultMap.get(alias);
		if (!config) {
			const available = Array.from(vaultMap.keys());
			throw new NodeOperationError(
				node,
				`Connection alias "${alias}" for query "${query.alias}" was not found in the Multi-DB Vault credential.` +
					(available.length ? ` Available: ${available.join(', ')}` : ''),
			);
		}
		return toResolvedConnection(config, timeoutMs, alias, node);
	}

	if (!query.inlineConnection) {
		throw new NodeOperationError(
			node,
			`Query "${query.alias}" requires inline connection details.`,
		);
	}
	return toResolvedConnection(
		query.inlineConnection,
		timeoutMs,
		`inline:${query.inlineConnection.dialect}`,
		node,
	);
}

async function executeSingleQueryStep(
	query: SqlQueryDefinition,
	context: SqlPipelineContext,
	globalSettings: GlobalSqlSettings,
	connInput: ConnectionResolutionInput,
	node: INode,
	sharedHandle?: ManagedDbHandle,
): Promise<SqlStepExecutionResult> {
	const timeoutMs =
		query.timeoutMs !== undefined && query.timeoutMs > 0
			? query.timeoutMs
			: globalSettings.timeoutMs;

	const startedAt = Date.now();
	const resolvedConn = resolveQueryConnection(query, connInput, timeoutMs, node);

	const interpolatedSql = interpolateSqlExpressions(query.sql, context);
	if (!interpolatedSql.trim()) {
		throw new NodeOperationError(
			node,
			`Query "${query.alias}" has an empty SQL statement.`,
		);
	}

	const compiled = buildSqlAndBindings(
		interpolatedSql,
		query.bindings,
		globalSettings.allowUnsafeSql,
		resolvedConn.dialect,
		context,
		node,
	);

	if (globalSettings.dryRun) {
		return {
			alias: query.alias,
			dialect: resolvedConn.dialect,
			connectionLabel: resolvedConn.label,
			success: true,
			rowCount: 0,
			data: {
				dryRun: true,
				dialect: resolvedConn.dialect,
				connection: resolvedConn.label,
				sql: compiled.sql,
				parameters: compiled.values,
			},
			sql: compiled.sql,
			parameters: compiled.values,
			durationMs: Date.now() - startedAt,
		};
	}

	if (compiled.emptyArrayGuard) {
		const extracted = query.dataPath ? extractByPath([], query.dataPath) : [];
		return {
			alias: query.alias,
			dialect: resolvedConn.dialect,
			connectionLabel: resolvedConn.label,
			success: true,
			rowCount: 0,
			data: extracted,
			sql: compiled.sql,
			parameters: compiled.values,
			durationMs: Date.now() - startedAt,
		};
	}

	const maxAttempts = 1 + Math.max(0, query.retryAttempts ?? 0);
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const rows = await runWithHandleAndTimeout(
				resolvedConn,
				compiled.sql,
				compiled.values,
				timeoutMs,
				query.alias,
				node,
				sharedHandle,
			);
			const extracted = query.dataPath
				? extractByPath(rows, query.dataPath)
				: rows;
			return {
				alias: query.alias,
				dialect: resolvedConn.dialect,
				connectionLabel: resolvedConn.label,
				success: true,
				rowCount: Array.isArray(rows) ? rows.length : 0,
				data: extracted,
				durationMs: Date.now() - startedAt,
			};
		} catch (err) {
			lastError = err;
			if (attempt < maxAttempts && globalSettings.retryDelayMs > 0) {
				await sleep(globalSettings.retryDelayMs);
			}
		}
	}

	if (lastError instanceof NodeOperationError) {
		throw lastError;
	}
	throw new NodeOperationError(
		node,
		lastError instanceof Error ? lastError.message : String(lastError),
	);
}

async function runWithHandleAndTimeout(
	resolvedConn: ResolvedConnection,
	sql: string,
	values: any[],
	timeoutMs: number,
	alias: string,
	node: INode,
	sharedHandle?: ManagedDbHandle,
): Promise<any[]> {
	if (sharedHandle) {
		return withTimeout(
			sharedHandle.query(sql, values),
			timeoutMs,
			`Query "${alias}"`,
			node,
		);
	}

	let ownHandle: ManagedDbHandle | undefined;
	let timedOut = false;

	const run = async (): Promise<any[]> => {
		ownHandle = await openManagedHandle(resolvedConn, node, { pooled: false });
		try {
			if (timedOut) {
				throw new NodeOperationError(
					node,
					`Query "${alias}" timed out after ${timeoutMs}ms`,
				);
			}
			return await ownHandle.query(sql, values);
		} catch (err) {
			await ownHandle.rollbackTransaction().catch(() => undefined);
			throw new NodeOperationError(
				node,
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			await ownHandle.close().catch(() => undefined);
		}
	};

	return withTimeout(run(), timeoutMs, `Query "${alias}"`, node, () => {
		timedOut = true;
		if (ownHandle) {
			void ownHandle.close().catch(() => undefined);
		}
	});
}

export async function executeMultiSqlQueries(
	mode: ExecutionMode,
	queries: SqlQueryDefinition[],
	context: SqlPipelineContext,
	globalSettings: GlobalSqlSettings,
	connInput: ConnectionResolutionInput,
	node: INode,
): Promise<void> {
	if (mode === 'pipeline') {
		const useTx =
			globalSettings.useTransaction &&
			!globalSettings.dryRun &&
			connInput.credentialScope === 'single';

		let txHandle: ManagedDbHandle | undefined;
		let txFailed = false;

		if (useTx) {
			if (!connInput.singleCredential) {
				throw new NodeOperationError(
					node,
					'Transaction mode requires the "Fox Schema SQL Database API" credential.',
				);
			}
			const resolved = toResolvedConnection(
				connInput.singleCredential,
				globalSettings.timeoutMs,
				'default',
				node,
			);
			txHandle = await openManagedHandle(resolved, node, { pooled: false });
			await txHandle.beginTransaction();
		}

		try {
			for (let i = 0; i < queries.length; i++) {
				const q = queries[i];
				if (i > 0 && globalSettings.delayBetweenStepsMs > 0) {
					await sleep(globalSettings.delayBetweenStepsMs);
				}

				try {
					const stepResult = await executeSingleQueryStep(
						q,
						context,
						globalSettings,
						connInput,
						node,
						txHandle,
					);
					context.pipeline[stepResult.alias] = stepResult;
					context.steps.push(stepResult);
					context.prev = stepResult;
				} catch (err: any) {
					const resolvedDialect = (() => {
						try {
							return resolveQueryConnection(
								q,
								connInput,
								globalSettings.timeoutMs,
								node,
							).dialect;
						} catch {
							return 'postgres' as const;
						}
					})();

					if (txHandle) {
						await txHandle.rollbackTransaction().catch(() => undefined);
						txFailed = true;
					}

					if (q.continueOnFail && !txHandle) {
						const failedResult: SqlStepExecutionResult = {
							alias: q.alias,
							dialect: resolvedDialect,
							connectionLabel: 'error',
							success: false,
							rowCount: 0,
							data: null,
							durationMs: 0,
							error: err?.message || String(err),
						};
						context.pipeline[q.alias] = failedResult;
						context.steps.push(failedResult);
						context.prev = failedResult;
						continue;
					}

					throw new NodeOperationError(
						node,
						`Query "${q.alias}" failed: ${err?.message || String(err)}`,
					);
				}
			}

			if (txHandle && !txFailed) {
				await txHandle.commitTransaction();
			}
		} finally {
			if (txHandle) {
				await txHandle.close().catch(() => undefined);
			}
		}
		return;
	}

	// Parallel (Concurrent) mode
	const concurrency = Math.max(1, globalSettings.concurrencyLimit || 5);
	for (let i = 0; i < queries.length; i += concurrency) {
		const batch = queries.slice(i, i + concurrency);
		const settled = await Promise.allSettled(
			batch.map((q) =>
				executeSingleQueryStep(q, context, globalSettings, connInput, node),
			),
		);

		for (let bIdx = 0; bIdx < settled.length; bIdx++) {
			const res = settled[bIdx];
			const q = batch[bIdx];

			if (res.status === 'fulfilled') {
				context.pipeline[res.value.alias] = res.value;
				context.steps.push(res.value);
				context.prev = res.value;
			} else {
				const resolvedDialect = (() => {
					try {
						return resolveQueryConnection(
							q,
							connInput,
							globalSettings.timeoutMs,
							node,
						).dialect;
					} catch {
						return 'postgres' as const;
					}
				})();

				if (q.continueOnFail) {
					const failedResult: SqlStepExecutionResult = {
						alias: q.alias,
						dialect: resolvedDialect,
						connectionLabel: 'error',
						success: false,
						rowCount: 0,
						data: null,
						durationMs: 0,
						error: res.reason?.message || String(res.reason),
					};
					context.pipeline[q.alias] = failedResult;
					context.steps.push(failedResult);
					context.prev = failedResult;
				} else {
					throw new NodeOperationError(
						node,
						`Parallel query "${q.alias}" failed: ${res.reason?.message || String(res.reason)}`,
					);
				}
			}
		}
	}
}
