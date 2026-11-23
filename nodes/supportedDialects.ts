import {
	dialectFamily as foxDialectFamily,
	isFileDialect as foxIsFileDialect,
} from './foxSchema';

export const SUPPORTED_DIALECTS = [
	'postgres',
	'cockroachdb',
	'yugabytedb',
	'redshift',
	'mysql',
	'mariadb',
	'tidb',
	'sqlserver',
	'azuresql',
	'oracle',
	'sqlite',
	'duckdb',
	'clickhouse',
] as const;

export type SupportedDialect = (typeof SUPPORTED_DIALECTS)[number];

export type DialectFamily =
	| 'postgres'
	| 'mysql'
	| 'sqlserver'
	| 'oracle'
	| 'sqlite'
	| 'clickhouse';

export const DEFAULT_SCHEMA: Record<SupportedDialect, string> = {
	postgres: 'public',
	cockroachdb: 'public',
	yugabytedb: 'public',
	redshift: 'public',
	mysql: '',
	mariadb: '',
	tidb: '',
	sqlserver: 'dbo',
	azuresql: 'dbo',
	oracle: '',
	sqlite: '',
	duckdb: 'main',
	clickhouse: '',
};

export function dialectFamily(dialect: SupportedDialect): DialectFamily {
	const family = foxDialectFamily(dialect);
	if (family === 'duckdb') return 'sqlite';
	return family as DialectFamily;
}

export function isFileDialect(dialect: string): boolean {
	return foxIsFileDialect(dialect);
}

export function isMysqlFamily(dialect: SupportedDialect): boolean {
	return dialectFamily(dialect) === 'mysql';
}

export function isSupportedDialect(value: string): value is SupportedDialect {
	return (SUPPORTED_DIALECTS as readonly string[]).includes(value.toLowerCase());
}

export function assertSupportedDialect(dialect: string): SupportedDialect {
	const normalized = String(dialect ?? '')
		.trim()
		.toLowerCase();

	if (normalized === 'db2') {
		throw new Error(
			'Dialect "db2" is not supported by n8n-nodes-fox-schema-multi-sql-queries. ' +
				'Db2 is excluded because ibm_db cannot install via n8n community nodes. ' +
				`Supported: ${SUPPORTED_DIALECTS.join(', ')}.`,
		);
	}

	if (normalized === 'mongodb' || normalized === 'redis') {
		throw new Error(
			`Dialect "${dialect}" is not a SQL engine. ` +
				`Supported: ${SUPPORTED_DIALECTS.join(', ')}.`,
		);
	}

	if (!isSupportedDialect(normalized)) {
		throw new Error(
			`Dialect "${dialect}" is not supported. Supported: ${SUPPORTED_DIALECTS.join(', ')}.`,
		);
	}

	return normalized;
}
