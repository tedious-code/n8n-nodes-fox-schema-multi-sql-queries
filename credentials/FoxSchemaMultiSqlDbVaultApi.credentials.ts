import {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

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

export class FoxSchemaMultiSqlDbVaultApi implements ICredentialType {
	name = 'foxSchemaMultiSqlDbVaultApi';
	displayName = 'Fox Schema Multi-DB Vault API';
	documentationUrl = 'https://foxschema.com';
	icon = {
		light: 'file:foxschema.svg',
		dark: 'file:foxschema.dark.svg',
	} as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Database Connections',
			name: 'connections',
			type: 'fixedCollection',
			typeOptions: {
				multipleValues: true,
				multipleValueButtonText: 'Add Database Connection',
			},
			placeholder: 'Add Database Connection',
			default: {
				connectionValues: [
					{
						alias: 'primary_db',
						dialect: 'postgres',
						connectionString: '',
						host: 'localhost',
						port: 5432,
						database: '',
						username: '',
						password: '',
						schema: '',
						useSsl: false,
						rejectUnauthorized: true,
					},
				],
			},
			description:
				'Store multiple encrypted database connections across any SQL dialect. Each query selects one by its Connection Alias.',
			options: [
				{
					name: 'connectionValues',
					displayName: 'Connection',
					values: [
						{
							displayName: 'Connection Alias',
							name: 'alias',
							type: 'string',
							required: true,
							default: 'primary_db',
							placeholder: 'e.g. main_pg, analytics_ch, erp_oracle',
							description:
								'Unique name used inside the Multi-SQL Queries node to route a query to this connection',
						},
						{
							displayName: 'Connection String (Optional)',
							name: 'connectionString',
							type: 'string',
							typeOptions: {
								password: true,
							},
							default: '',
							placeholder: 'postgres://user:pass@host:5432/db or /data/app.db',
							description:
								'Optional full connection URI or file path; overrides host/port/database when set',
						},
						{
							displayName: 'Database / Service',
							name: 'database',
							type: 'string',
							default: '',
							displayOptions: {
								show: {
									dialect: NETWORK_DIALECTS,
								},
							},
						},
						{
							displayName: 'Database File Path',
							name: 'database',
							type: 'string',
							default: '',
							placeholder: '/data/app.db',
							displayOptions: {
								show: {
									dialect: FILE_DIALECTS,
								},
							},
						},
						{
							displayName: 'Dialect',
							name: 'dialect',
							type: 'options',
							options: [
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
							],
							default: 'postgres',
						},
						{
							displayName: 'Host',
							name: 'host',
							type: 'string',
							default: 'localhost',
							displayOptions: {
								show: {
									dialect: NETWORK_DIALECTS,
								},
							},
						},
						{
							displayName: 'Password',
							name: 'password',
							type: 'string',
							typeOptions: {
								password: true,
							},
							default: '',
							displayOptions: {
								show: {
									dialect: NETWORK_DIALECTS,
								},
							},
						},
						{
							displayName: 'Port',
							name: 'port',
							type: 'number',
							default: 5432,
							displayOptions: {
								show: {
									dialect: NETWORK_DIALECTS,
								},
							},
						},
						{
							displayName: 'Reject Unauthorized SSL',
							name: 'rejectUnauthorized',
							type: 'boolean',
							default: true,
							displayOptions: {
								show: {
									useSsl: [true],
									dialect: NETWORK_DIALECTS,
								},
							},
						},
						{
							displayName: 'Schema',
							name: 'schema',
							type: 'string',
							default: '',
						},
						{
							displayName: 'Use SSL',
							name: 'useSsl',
							type: 'boolean',
							default: false,
							displayOptions: {
								show: {
									dialect: NETWORK_DIALECTS,
								},
							},
						},
						{
							displayName: 'Username',
							name: 'username',
							type: 'string',
							default: '',
							displayOptions: {
								show: {
									dialect: NETWORK_DIALECTS,
								},
							},
						},
					],
				},
			],
		},
	];

	// Required by n8n community verification; node registers `testedBy: 'vaultConnectionTest'`.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'http://localhost',
			url: '/',
		},
	};
}
