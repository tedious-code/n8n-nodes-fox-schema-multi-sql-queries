/**
 * Loads the bundled FoxSchema (@foxschema/db + @foxschema/sql) CJS build
 * produced by scripts/bundle-foxschema.mjs.
 * Relative import only — n8n community verification forbids fs/process/__dirname in node JS.
 */
export {
	ConnectionFactory,
	getAdapter,
	getRegisteredProvider,
	openDatabase,
	queryOnce,
	assertSafeIdentifier,
	dialectSupportsTransactionalRollback,
	DEFAULT_PORTS,
	PROVIDER_SETTINGS,
	getProviderSettings,
	dialectFamily,
	isFileDialect,
	placeholderStyleFor,
	renderPlaceholder,
	quoteSqlIdentifier,
	quoteQualifiedName,
	sqlLiteral,
	sqlReadingsFor,
	sqlTokens,
} from './vendor/foxschema-core.cjs';

export type {
	OpenDatabase,
	SqlPlaceholderStyle,
	SqlToken,
	SqlTokenOptions,
} from './vendor/foxschema-core.cjs';
