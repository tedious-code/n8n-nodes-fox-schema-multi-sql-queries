import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { FoxSchemaMultiSqlQueries } from '../nodes/FoxSchemaMultiSqlQueries/FoxSchemaMultiSqlQueries.node.ts';
import { withTimeout } from '../nodes/dbConnection';
import { ConnectionFactory } from '../nodes/foxSchema';

function setupTempDbs() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-multi-sql-'));
	const usersDbPath = path.join(dir, 'users.db');
	const ordersDbPath = path.join(dir, 'orders.db');

	const udb = new Database(usersDbPath);
	udb.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL);
		INSERT INTO users (id, name, tier) VALUES (1, 'Alice', 'pro'), (2, 'Bob', 'free');
	`);
	udb.close();

	const odb = new Database(ordersDbPath);
	odb.exec(`
		CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, total INTEGER NOT NULL);
		INSERT INTO orders (id, user_id, total) VALUES (101, 1, 250), (102, 1, 150), (103, 2, 50);
	`);
	odb.close();

	return { dir, usersDbPath, ordersDbPath };
}

function getParam(obj: Record<string, any>, pathStr: string, fallback?: any) {
	const parts = pathStr.split('.');
	let cur: any = obj;
	for (const p of parts) {
		if (cur === undefined || cur === null) return fallback;
		cur = cur[p];
	}
	return cur === undefined ? fallback : cur;
}

const TEST_NODE: INode = {
	id: 'test-node',
	name: 'Fox Schema Multi SQL Queries',
	type: 'n8n-nodes-fox-schema-multi-sql-queries.foxSchemaMultiSqlQueries',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function createMockExecuteContext(opts: {
	inputItems?: INodeExecutionData[];
	params: Record<string, any>;
	singleCredential?: Record<string, any>;
	vaultCredential?: Record<string, any>;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const inputItems = opts.inputItems ?? [{ json: {} }];
	return {
		getInputData: () => inputItems,
		getNodeParameter: (name: string, _itemIndex: number, fallback?: any) =>
			getParam(opts.params, name, fallback),
		getCredentials: async (credName: string) => {
			if (credName === 'foxSchemaMultiSqlDbApi' && opts.singleCredential) {
				return opts.singleCredential;
			}
			if (credName === 'foxSchemaMultiSqlDbVaultApi' && opts.vaultCredential) {
				return opts.vaultCredential;
			}
			throw new Error(`Credential ${credName} not configured`);
		},
		continueOnFail: () => opts.continueOnFail === true,
		getNode: () => TEST_NODE,
	} as unknown as IExecuteFunctions;
}

test.after(async () => {
	await ConnectionFactory.closeAll();
});

test('single credential: serial pipeline chains $pipeline and $prev across queries', async () => {
	const { dir, usersDbPath } = setupTempDbs();
	try {
		const node = new FoxSchemaMultiSqlQueries();
		const ctx = createMockExecuteContext({
			inputItems: [{ json: { targetName: 'Alice' } }],
			singleCredential: { dialect: 'sqlite', database: usersDbPath },
			params: {
				credentialScope: 'single',
				operation: 'pipeline',
				responseMode: 'mergeAllToObject',
				timeoutMs: 5000,
				queries: {
					queryValues: [
						{
							alias: 'findUser',
							sql: 'SELECT id, name, tier FROM users WHERE name = ?',
							binding: {
								parameterValues: [{ type: 'string', value: '{{ $json.targetName }}' }],
							},
						},
						{
							alias: 'sameTierUsers',
							sql: 'SELECT id, name FROM users WHERE tier = ? AND id = ?',
							binding: {
								parameterValues: [
									{ type: 'string', value: '{{ $prev.data[0].tier }}' },
									{ type: 'number', value: '{{ $pipeline.findUser.data[0].id }}' },
								],
							},
						},
					],
				},
			},
		});

		const [out] = await node.execute.call(ctx);
		assert.equal(out.length, 1);
		assert.equal((out[0].json.findUser as any).rowCount, 1);
		assert.deepEqual((out[0].json.sameTierUsers as any).data, [{ id: 1, name: 'Alice' }]);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('multi-DB vault: serial & parallel queries across different databases and output modes', async () => {
	const { dir, usersDbPath, ordersDbPath } = setupTempDbs();
	try {
		const node = new FoxSchemaMultiSqlQueries();
		const vaultCredential = {
			connections: {
				connectionValues: [
					{ alias: 'users_db', dialect: 'sqlite', database: usersDbPath },
					{ alias: 'orders_db', dialect: 'sqlite', database: ordersDbPath },
				],
			},
		};

		const serialCtx = createMockExecuteContext({
			vaultCredential,
			params: {
				credentialScope: 'multiVault',
				operation: 'pipeline',
				responseMode: 'lastResponse',
				timeoutMs: 5000,
				queries: {
					queryValues: [
						{
							alias: 'userStep',
							vaultAlias: 'users_db',
							sql: 'SELECT id FROM users WHERE name = ?',
							binding: { parameterValues: [{ type: 'string', value: 'Alice' }] },
						},
						{
							alias: 'orderStep',
							vaultAlias: 'orders_db',
							sql: 'SELECT id, total FROM orders WHERE user_id = ? ORDER BY id',
							binding: {
								parameterValues: [
									{ type: 'number', value: '{{ $pipeline.userStep.data[0].id }}' },
								],
							},
						},
					],
				},
			},
		});
		const [serialOut] = await node.execute.call(serialCtx);
		assert.deepEqual(
			serialOut.map((i) => i.json),
			[
				{ id: 101, total: 250 },
				{ id: 102, total: 150 },
			],
		);

		for (const responseMode of ['allAsArray', 'splitToItems', 'mergeIntoInput', 'firstResponse'] as const) {
			const parallelCtx = createMockExecuteContext({
				inputItems: [{ json: { reqId: 'r-1' } }],
				vaultCredential,
				params: {
					credentialScope: 'multiVault',
					operation: 'parallel',
					responseMode,
					timeoutMs: 5000,
					globalSettings: { concurrencyLimit: 2 },
					queries: {
						queryValues: [
							{
								alias: 'usersCount',
								vaultAlias: 'users_db',
								sql: 'SELECT COUNT(*) AS cnt FROM users',
							},
							{
								alias: 'ordersSum',
								vaultAlias: 'orders_db',
								sql: 'SELECT SUM(total) AS total_sum FROM orders',
							},
						],
					},
				},
			});
			const [pOut] = await node.execute.call(parallelCtx);
			if (responseMode === 'allAsArray') {
				assert.equal((pOut[0].json.results as any[]).length, 2);
				assert.equal((pOut[0].json.results as any[])[0].alias, 'usersCount');
				assert.equal((pOut[0].json.results as any[])[1].alias, 'ordersSum');
			} else if (responseMode === 'splitToItems') {
				assert.equal(pOut.length, 2);
				assert.equal(pOut[0].json.alias, 'usersCount');
				assert.equal(pOut[1].json.alias, 'ordersSum');
			} else if (responseMode === 'mergeIntoInput') {
				assert.equal(pOut[0].json.reqId, 'r-1');
				assert.deepEqual(pOut[0].json.usersCount, [{ cnt: 2 }]);
				assert.deepEqual(pOut[0].json.ordersSum, [{ total_sum: 450 }]);
			} else if (responseMode === 'firstResponse') {
				assert.deepEqual(pOut[0].json, { cnt: 2 });
			}
		}
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('perQuery inline connections: multiple DBs + continueOnFail + dryRun', async () => {
	const { dir, usersDbPath, ordersDbPath } = setupTempDbs();
	try {
		const node = new FoxSchemaMultiSqlQueries();
		const inlineCtx = createMockExecuteContext({
			params: {
				credentialScope: 'perQuery',
				operation: 'parallel',
				responseMode: 'mergeAllToObject',
				timeoutMs: 5000,
				queries: {
					queryValues: [
						{
							alias: 'userStep',
							inlineDialect: 'sqlite',
							inlineDatabase: usersDbPath,
							sql: 'SELECT name FROM users WHERE id = 2',
							dataPath: '[0].name',
						},
						{
							alias: 'orderStep',
							inlineDialect: 'sqlite',
							inlineDatabase: ordersDbPath,
							sql: 'SELECT total FROM orders WHERE id = 103',
							dataPath: '[0].total',
						},
						{
							alias: 'failingStep',
							inlineDialect: 'sqlite',
							inlineDatabase: usersDbPath,
							sql: 'SELECT * FROM nonexistent_table',
							continueOnFail: true,
						},
					],
				},
			},
		});

		const [out] = await node.execute.call(inlineCtx);
		assert.equal((out[0].json.userStep as any).data, 'Bob');
		assert.equal((out[0].json.orderStep as any).data, 50);
		assert.equal((out[0].json.failingStep as any).success, false);
		assert.match((out[0].json.failingStep as any).error, /nonexistent_table/);

		const dryCtx = createMockExecuteContext({
			singleCredential: { dialect: 'postgres', host: 'localhost', database: 'app', username: 'u' },
			params: {
				credentialScope: 'single',
				operation: 'pipeline',
				dryRun: true,
				queries: {
					queryValues: [
						{
							alias: 'pgQuery',
							sql: 'SELECT * FROM users WHERE id = ?',
							binding: { parameterValues: [{ type: 'number', value: '12' }] },
						},
					],
				},
			},
		});
		const [dryOut] = await node.execute.call(dryCtx);
		assert.equal((dryOut[0].json.pgQuery as any).sql, 'SELECT * FROM users WHERE id = $1');
		assert.deepEqual((dryOut[0].json.pgQuery as any).parameters, [12]);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('single credential transaction rolls back on failure', async () => {
	const { dir, usersDbPath } = setupTempDbs();
	try {
		const node = new FoxSchemaMultiSqlQueries();
		const txCtx = createMockExecuteContext({
			singleCredential: { dialect: 'sqlite', database: usersDbPath },
			params: {
				credentialScope: 'single',
				operation: 'pipeline',
				useTransaction: true,
				queries: {
					queryValues: [
						{
							alias: 'insertUser',
							sql: "INSERT INTO users (id, name, tier) VALUES (3, 'Charlie', 'pro')",
						},
						{
							alias: 'boom',
							sql: 'INSERT INTO missing_table (x) VALUES (1)',
						},
					],
				},
			},
		});

		await assert.rejects(() => node.execute.call(txCtx), /missing_table/);

		const verifyDb = new Database(usersDbPath);
		const rows = verifyDb.prepare('SELECT id FROM users ORDER BY id').all();
		verifyDb.close();
		assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('withTimeout rejects slow promises and triggers onTimeout callback', async () => {
	let cleaned = false;
	await assert.rejects(
		() =>
			withTimeout(
				new Promise((resolve) => setTimeout(() => resolve('late'), 200)),
				30,
				'Slow query',
				TEST_NODE,
				() => {
					cleaned = true;
				},
			),
		/Slow query timed out after 30ms/,
	);
	assert.equal(cleaned, true);
});
