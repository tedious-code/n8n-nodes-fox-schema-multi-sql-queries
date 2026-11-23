import {
	NodeConnectionTypes,
	NodeOperationError,
	type ICredentialDataDecryptedObject,
	type ICredentialTestFunctions,
	type ICredentialsDecrypted,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeCredentialTestResult,
	type INodeExecutionData,
	type INodeProperties,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import {
	extractVaultMap,
	testSingleConnection,
	testVaultConnections,
} from '../dbConnection';
import { formatExecutionOutput } from '../outputFormatter';
import { executeMultiSqlQueries } from '../queryEngine';
import type {
	BindingParam,
	CredentialScope,
	ExecutionMode,
	GlobalSqlSettings,
	OutputAggregationMode,
	SqlPipelineContext,
	SqlQueryDefinition,
} from '../types';

const DIALECT_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Amazon Redshift', value: 'redshift' },
	{ name: 'Azure SQL', value: 'azuresql' },
	{ name: 'ClickHouse', value: 'clickhouse' },
	{ name: 'CockroachDB', value: 'cockroachdb' },
	{ name: 'DuckDB', value: 'duckdb' },
	{ name: 'MariaDB', value: 'mariadb' },
	{ name: 'MySQL', value: 'mysql' },
	{ name: 'Oracle', value: 'oracle' },
	{ name: 'PostgreSQL', value: 'postgres' },
	{ name: 'SQL Server', value: 'sqlserver' },
	{ name: 'SQLite', value: 'sqlite' },
	{ name: 'TiDB', value: 'tidb' },
	{ name: 'YugabyteDB', value: 'yugabytedb' },
];

const NETWORK_DIALECTS = [
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
	'clickhouse',
];

const FILE_DIALECTS = ['sqlite', 'duckdb'];

const INLINE_CONNECTION_FIELDS: INodeProperties[] = [
	{
		displayName: 'Connection String (Optional)',
		name: 'inlineConnectionString',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		placeholder: 'postgres://user:pass@host:5432/db or /data/app.db',
		description:
			'Optional full connection URI or file path; overrides host/port/database below when provided',
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
			},
		},
	},
	{
		displayName: 'Database / Service',
		name: 'inlineDatabase',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
				inlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Database File Path',
		name: 'inlineDatabase',
		type: 'string',
		default: '',
		placeholder: '/data/app.db',
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
				inlineDialect: FILE_DIALECTS,
			},
		},
	},
	{
		displayName: 'Dialect',
		name: 'inlineDialect',
		type: 'options',
		options: DIALECT_OPTIONS,
		default: 'postgres',
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
			},
		},
	},
	{
		displayName: 'Host',
		name: 'inlineHost',
		type: 'string',
		default: 'localhost',
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
				inlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Password',
		name: 'inlinePassword',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
				inlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Port',
		name: 'inlinePort',
		type: 'number',
		default: 5432,
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
				inlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Reject Unauthorized SSL',
		name: 'inlineRejectUnauthorized',
		type: 'boolean',
		default: true,
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
				inlineDialect: NETWORK_DIALECTS,
				inlineUseSsl: [true],
			},
		},
	},
	{
		displayName: 'Schema',
		name: 'inlineSchema',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
			},
		},
	},
	{
		displayName: 'Use SSL',
		name: 'inlineUseSsl',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
				inlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Username',
		name: 'inlineUsername',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				'/credentialScope': ['perQuery'],
				inlineDialect: NETWORK_DIALECTS,
			},
		},
	},
];

const RESPONSE_OUTPUT_OPTIONS: INodePropertyOptions[] = [
	{
		name: 'All Responses as Array',
		value: 'allAsArray',
		description: 'Return { results: [...] } containing all query execution responses',
	},
	{
		name: 'First Response Only',
		value: 'firstResponse',
		description: 'Emit rows or data only from the first executed query',
	},
	{
		name: 'Last Response Only',
		value: 'lastResponse',
		description: 'Emit rows or data only from the final executed query',
	},
	{
		name: 'Merge All Responses Into an Object',
		value: 'mergeAllToObject',
		description:
			'Combine all query results into one object keyed by step alias (for example { step1: { dialect, rowCount, data } })',
	},
	{
		name: 'Merge Into Input Item',
		value: 'mergeIntoInput',
		description:
			'Merge each query result directly into the incoming JSON object keyed by alias',
	},
	{
		name: 'Split Each Response to New Item',
		value: 'splitToItems',
		description: 'Emit each query response as an individual n8n output item',
	},
];

export class FoxSchemaMultiSqlQueries implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Fox Schema Multi SQL Queries',
		name: 'foxSchemaMultiSqlQueries',
		icon: {
			light: 'file:foxschema.svg',
			dark: 'file:foxschema.dark.svg',
		},
		group: ['transform', 'output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + " · " + $parameter["credentialScope"]}}',
		description:
			'Execute multiple SQL queries serially or in parallel across one shared database credential or different credentials/dialects per query using @foxschema/db',
		documentationUrl: 'https://foxschema.com',
		defaults: {
			name: 'Fox Schema Multi SQL Queries',
		},
		codex: {
			categories: ['Data & Storage', 'Development'],
			resources: {
				primaryDocumentation: [{ url: 'https://foxschema.com' }],
				credentialDocumentation: [{ url: 'https://foxschema.com' }],
			},
			alias: [
				'sql',
				'multi-sql',
				'database',
				'foxschema',
				'postgres',
				'mysql',
				'oracle',
				'mssql',
				'sqlite',
				'clickhouse',
				'duckdb',
			],
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'foxSchemaMultiSqlDbApi',
				required: true,
				testedBy: 'dbConnectionTest',
				displayOptions: {
					show: {
						credentialScope: ['single'],
					},
				},
			},
			{
				name: 'foxSchemaMultiSqlDbVaultApi',
				required: true,
				testedBy: 'vaultConnectionTest',
				displayOptions: {
					show: {
						credentialScope: ['multiVault'],
					},
				},
			},
		],
		properties: [
			{
				displayName:
					'Powered by <a href="https://foxschema.com" target="_blank">FoxSchema (@foxschema/db)</a> — multi-dialect SQL execution across Postgres, MySQL, SQL Server, Oracle, SQLite, DuckDB, ClickHouse, and more.',
				name: 'foxSchemaBacklink',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Connection Mode',
				name: 'credentialScope',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Multi-DB Vault Credential (Per Query)',
						value: 'multiVault',
						description:
							'Use a Fox Schema Multi-DB Vault credential holding multiple database connections/dialects and pick one by alias per query',
					},
					{
						name: 'One Credential (All Queries)',
						value: 'single',
						description:
							'Use one Fox Schema SQL Database API credential for every query',
					},
					{
						name: 'Per-Query Inline Connection',
						value: 'perQuery',
						description:
							'Configure dialect, host, credentials, or connection string directly on each query (supports expressions)',
					},
				],
				default: 'single',
				description:
					'Whether all queries share one database credential or each query connects to a different database or dialect',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Execute Parallel',
						value: 'parallel',
						description:
							'Execute queries concurrently across one or multiple databases and aggregate all responses',
						action: 'Execute queries in parallel',
					},
					{
						name: 'Execute Serial Pipe',
						value: 'pipeline',
						description:
							'Execute queries in order so downstream queries can read prior step outputs by alias',
						action: 'Execute queries serially',
					},
				],
				default: 'pipeline',
				description: 'How configured SQL queries should be processed',
			},
			{
				displayName: 'Response Output',
				name: 'responseMode',
				type: 'options',
				options: RESPONSE_OUTPUT_OPTIONS,
				default: 'mergeAllToObject',
				description: 'How query results should be structured in the node output',
			},
			{
				displayName: 'Timeout (Ms)',
				name: 'timeoutMs',
				type: 'number',
				default: 5000,
				description:
					'Default timeout in milliseconds for each query (connect + execute). Set to 0 to disable.',
			},
			{
				displayName: 'Use Transaction',
				name: 'useTransaction',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['pipeline'],
						credentialScope: ['single'],
					},
				},
				description:
					'Whether to wrap all serial queries in a single database transaction and roll back on any query error',
			},
			{
				displayName: 'Allow Unsafe SQL',
				name: 'allowUnsafeSql',
				type: 'boolean',
				default: false,
				description:
					'Whether to allow SQL Expression typed bind parameters. Keep disabled unless you trust every workflow editor.',
			},
			{
				displayName: 'Preview Queries (Dry Run)',
				name: 'dryRun',
				type: 'boolean',
				default: false,
				description:
					'Whether to compile SQL statements and bind parameters without executing them against databases',
			},
			{
				displayName: 'Queries',
				name: 'queries',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add SQL Query',
				},
				placeholder: 'Add SQL Query',
				default: {
					queryValues: [
						{
							alias: 'step1',
							sql: 'SELECT 1 AS ok',
						},
					],
				},
				options: [
					{
						name: 'queryValues',
						displayName: 'SQL Query',
						values: [
							{
								displayName: 'Alias / Step Name',
								name: 'alias',
								type: 'string',
								default: 'step1',
								placeholder: 'e.g. users, orders, analytics',
								description:
									'Unique identifier for referencing this query in downstream steps and output',
							},
							{
								displayName: 'Bind Parameters',
								name: 'binding',
								type: 'fixedCollection',
								typeOptions: {
									multipleValues: true,
									multipleValueButtonText: 'Add Parameter',
								},
								default: {},
								description:
									'Values bound sequentially to ? placeholders (rewritten automatically to $1, @p1, :1, or ? per dialect)',
								options: [
									{
										name: 'parameterValues',
										displayName: 'Parameter',
										values: [
											{
												displayName: 'Type',
												name: 'type',
												type: 'options',
												default: 'string',
												options: [
													{ name: 'Boolean', value: 'boolean' },
													{ name: 'Date', value: 'date' },
													{ name: 'JSON', value: 'json' },
													{ name: 'Null', value: 'null' },
													{ name: 'Number', value: 'number' },
													{ name: 'SQL Expression', value: 'sql' },
													{ name: 'String', value: 'string' },
												],
											},
											{
												displayName: 'Value',
												name: 'value',
												type: 'string',
												default: '',
												placeholder:
													'e.g. {{ $json.userID }} or {{ $pipeline.step1.data[0].userID }}',
												description:
													'Supports static values and expressions referencing input items or prior pipeline steps',
											},
										],
									},
								],
							},
							{
								displayName: 'Continue on Fail',
								name: 'continueOnFail',
								type: 'boolean',
								default: false,
								description:
									'Whether to continue executing remaining queries if this query fails (ignored when Use Transaction is enabled)',
							},
							...INLINE_CONNECTION_FIELDS,
							{
								displayName: 'Response Data Path',
								name: 'dataPath',
								type: 'string',
								default: '',
								placeholder: 'e.g. [0] or 0.userID',
								description:
									'Optional dot/bracket path to extract from the returned rows array (empty returns all rows)',
							},
							{
								displayName: 'Retry Attempts',
								name: 'retryAttempts',
								type: 'number',
								default: 0,
								description:
									'Number of retry attempts if this query fails or times out',
							},
							{
								displayName: 'SQL',
								name: 'sql',
								type: 'string',
								required: true,
								default: '',
								typeOptions: {
									editor: 'sqlEditor',
									sqlDialect: 'StandardSQL',
									rows: 5,
								},
								placeholder: 'SELECT * FROM users WHERE id = ?',
								description:
									'SQL query to execute using ? placeholders with Bind Parameters or pipeline expressions',
							},
							{
								displayName: 'Timeout (Ms)',
								name: 'timeoutMs',
								type: 'number',
								default: 0,
								description:
									'Optional per-query timeout override in milliseconds (0 uses node Timeout)',
							},
							{
								displayName: 'Vault Connection Name or ID',
								name: 'vaultAlias',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getVaultConnections',
								},
								default: '',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								displayOptions: {
									show: {
										'/credentialScope': ['multiVault'],
									},
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Global Settings',
				name: 'globalSettings',
				type: 'collection',
				placeholder: 'Add Global Setting',
				default: {},
				options: [
					{
						displayName: 'Concurrency Limit',
						name: 'concurrencyLimit',
						type: 'number',
						default: 5,
						description:
							'Maximum concurrent queries when running in Parallel mode',
					},
					{
						displayName: 'Delay Between Steps (Ms)',
						name: 'delayBetweenStepsMs',
						type: 'number',
						default: 0,
						description:
							'Pause duration between consecutive queries in Serial mode',
					},
					{
						displayName: 'Fallback Output Mode',
						name: 'outputMode',
						type: 'options',
						options: RESPONSE_OUTPUT_OPTIONS,
						default: 'mergeAllToObject',
					},
					{
						displayName: 'Retry Delay (Ms)',
						name: 'retryDelayMs',
						type: 'number',
						default: 500,
						description: 'Delay between retry attempts on failure',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeoutMs',
						type: 'number',
						default: 5000,
						description: 'Fallback query timeout in milliseconds',
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			async dbConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as ICredentialDataDecryptedObject;
				const res = await testSingleConnection(credentials);
				if (!res.ok) {
					return { status: 'Error', message: res.message };
				}
				return { status: 'OK', message: 'Connection successful!' };
			},
			async vaultConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as ICredentialDataDecryptedObject;
				const res = await testVaultConnections(credentials);
				if (!res.ok) {
					return { status: 'Error', message: res.message };
				}
				return {
					status: 'OK',
					message: `All ${res.testedCount} vault connection(s) succeeded: ${res.aliases.join(', ')}`,
				};
			},
		},
		loadOptions: {
			async getVaultConnections(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				try {
					const vault = await this.getCredentials<ICredentialDataDecryptedObject>(
						'foxSchemaMultiSqlDbVaultApi',
					);
					const map = extractVaultMap(vault);
					return Array.from(map.entries()).map(([alias, cfg]) => ({
						name: `${alias} (${cfg.dialect})`,
						value: alias,
					}));
				} catch {
					return [];
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const node = this.getNode();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const credentialScope = this.getNodeParameter(
					'credentialScope',
					itemIndex,
					'single',
				) as CredentialScope;
				const operation = this.getNodeParameter(
					'operation',
					itemIndex,
					'pipeline',
				) as ExecutionMode;
				const rawQueries = this.getNodeParameter(
					'queries.queryValues',
					itemIndex,
					[],
				) as any[];
				const globalConfig = this.getNodeParameter(
					'globalSettings',
					itemIndex,
					{},
				) as Record<string, any>;

				const topTimeout = this.getNodeParameter(
					'timeoutMs',
					itemIndex,
					5000,
				) as number;
				const timeoutMs =
					topTimeout !== undefined && topTimeout !== null
						? topTimeout
						: (globalConfig.timeoutMs ?? 5000);

				const topResponseMode = this.getNodeParameter(
					'responseMode',
					itemIndex,
					'',
				) as string;
				const outputMode = (topResponseMode ||
					globalConfig.outputMode ||
					'mergeAllToObject') as OutputAggregationMode;

				const globalSettings: GlobalSqlSettings = {
					timeoutMs,
					concurrencyLimit: globalConfig.concurrencyLimit || 5,
					delayBetweenStepsMs: globalConfig.delayBetweenStepsMs || 0,
					retryDelayMs: globalConfig.retryDelayMs ?? 500,
					allowUnsafeSql: this.getNodeParameter(
						'allowUnsafeSql',
						itemIndex,
						false,
					) as boolean,
					dryRun: this.getNodeParameter('dryRun', itemIndex, false) as boolean,
					useTransaction: this.getNodeParameter(
						'useTransaction',
						itemIndex,
						false,
					) as boolean,
				};

				const queries: SqlQueryDefinition[] = rawQueries.map((q, idx) => ({
					alias: q.alias ? String(q.alias).trim() : `step_${idx + 1}`,
					connectionSource:
						credentialScope === 'perQuery'
							? 'inline'
							: credentialScope === 'multiVault'
								? 'vaultAlias'
								: 'defaultCredential',
					vaultAlias: q.vaultAlias ? String(q.vaultAlias).trim() : undefined,
					inlineConnection:
						credentialScope === 'perQuery'
							? {
									dialect: q.inlineDialect || 'postgres',
									connectionString: q.inlineConnectionString,
									host: q.inlineHost,
									port: q.inlinePort,
									database: q.inlineDatabase,
									username: q.inlineUsername,
									password: q.inlinePassword,
									schema: q.inlineSchema,
									useSsl: q.inlineUseSsl,
									rejectUnauthorized: q.inlineRejectUnauthorized,
								}
							: undefined,
					sql: String(q.sql ?? ''),
					bindings: (q.binding?.parameterValues || []) as BindingParam[],
					dataPath: q.dataPath ? String(q.dataPath).trim() : undefined,
					continueOnFail: q.continueOnFail === true,
					timeoutMs:
						q.timeoutMs !== undefined &&
						q.timeoutMs !== null &&
						Number(q.timeoutMs) > 0
							? Number(q.timeoutMs)
							: undefined,
					retryAttempts: Number(q.retryAttempts || 0),
				}));

				if (queries.length === 0) {
					throw new NodeOperationError(
						node,
						'At least one SQL query must be defined in Fox Schema Multi SQL Queries',
						{ itemIndex },
					);
				}

				let singleCredential: ICredentialDataDecryptedObject | undefined;
				let vaultCredential: ICredentialDataDecryptedObject | undefined;

				if (credentialScope === 'single') {
					singleCredential =
						await this.getCredentials<ICredentialDataDecryptedObject>(
							'foxSchemaMultiSqlDbApi',
							itemIndex,
						);
				} else if (credentialScope === 'multiVault') {
					vaultCredential =
						await this.getCredentials<ICredentialDataDecryptedObject>(
							'foxSchemaMultiSqlDbVaultApi',
							itemIndex,
						);
				}

				const context: SqlPipelineContext = {
					json: items[itemIndex].json,
					pipeline: {},
					steps: [],
					prev: undefined,
					itemIndex,
				};

				await executeMultiSqlQueries(
					operation,
					queries,
					context,
					globalSettings,
					{
						credentialScope,
						singleCredential,
						vaultCredential,
					},
					node,
				);

				const formattedItems = formatExecutionOutput(
					context,
					outputMode,
					items[itemIndex],
				);
				returnData.push(...formattedItems);
			} catch (error: any) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error?.message || String(error),
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw error instanceof NodeOperationError
					? error
					: new NodeOperationError(node, error?.message || String(error), {
							itemIndex,
						});
			}
		}

		return [returnData];
	}
}
