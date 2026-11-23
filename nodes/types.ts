import type { SupportedDialect } from './supportedDialects';

export type ExecutionMode = 'pipeline' | 'parallel';

export type CredentialScope = 'single' | 'multiVault' | 'perQuery';

export type QueryConnectionSource = 'defaultCredential' | 'vaultAlias' | 'inline';

export type OutputAggregationMode =
	| 'mergeAllToObject'
	| 'allAsObject'
	| 'lastResponse'
	| 'lastStepOnly'
	| 'firstResponse'
	| 'allAsArray'
	| 'splitToItems'
	| 'mergeIntoInput';

export type BindingParamType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'date'
	| 'null'
	| 'json'
	| 'sql';

export interface BindingParam {
	type: BindingParamType;
	value?: string;
}

export interface DatabaseConnectionConfig {
	alias?: string;
	dialect: string;
	connectionString?: string;
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	schema?: string;
	useSsl?: boolean;
	rejectUnauthorized?: boolean;
}

export interface SqlQueryDefinition {
	alias: string;
	connectionSource: QueryConnectionSource;
	vaultAlias?: string;
	inlineConnection?: DatabaseConnectionConfig;
	sql: string;
	bindings: BindingParam[];
	dataPath?: string;
	continueOnFail?: boolean;
	timeoutMs?: number;
	retryAttempts?: number;
}

export interface GlobalSqlSettings {
	timeoutMs: number;
	concurrencyLimit: number;
	delayBetweenStepsMs: number;
	retryDelayMs: number;
	allowUnsafeSql: boolean;
	dryRun: boolean;
	useTransaction: boolean;
}

export interface SqlStepExecutionResult {
	alias: string;
	dialect: SupportedDialect;
	connectionLabel: string;
	success: boolean;
	rowCount: number;
	data: any;
	durationMs: number;
	sql?: string;
	parameters?: any[];
	error?: string;
}

export interface SqlPipelineContext {
	json: Record<string, any>;
	pipeline: Record<string, SqlStepExecutionResult>;
	steps: SqlStepExecutionResult[];
	prev?: SqlStepExecutionResult;
	itemIndex: number;
}

export interface ResolvedConnection {
	dialect: SupportedDialect;
	label: string;
	options: Record<string, unknown>;
}
