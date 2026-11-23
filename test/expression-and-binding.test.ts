import test from 'node:test';
import assert from 'node:assert/strict';
import {
	extractByPath,
	interpolateSqlExpressions,
	resolveExpressionValue,
} from '../nodes/expressionResolver';
import { buildSqlAndBindings, rewritePlaceholders } from '../nodes/sqlBinding';
import type { SqlPipelineContext } from '../nodes/types';

function makeContext(): SqlPipelineContext {
	return {
		json: { userId: 42, status: 'active', ids: [10, 20, 30] },
		pipeline: {
			fetchUser: {
				alias: 'fetchUser',
				dialect: 'postgres',
				connectionLabel: 'main_pg',
				success: true,
				rowCount: 1,
				data: [{ id: 99, org_id: 7, roles: ['admin', 'editor'] }],
				durationMs: 12,
			},
		},
		steps: [
			{
				alias: 'fetchUser',
				dialect: 'postgres',
				connectionLabel: 'main_pg',
				success: true,
				rowCount: 1,
				data: [{ id: 99, org_id: 7, roles: ['admin', 'editor'] }],
				durationMs: 12,
			},
		],
		prev: {
			alias: 'fetchUser',
			dialect: 'postgres',
			connectionLabel: 'main_pg',
			success: true,
			rowCount: 1,
			data: [{ id: 99, org_id: 7, roles: ['admin', 'editor'] }],
			durationMs: 12,
		},
		itemIndex: 0,
	};
}

test('extractByPath handles dot and bracket notation', () => {
	const data = { user: { roles: ['admin', 'viewer'] }, items: [{ id: 5 }] };
	assert.equal(extractByPath(data, 'user.roles[1]'), 'viewer');
	assert.equal(extractByPath(data, 'items[0].id'), 5);
	assert.equal(extractByPath(data, '$json.items[0].id'), 5);
	assert.equal(extractByPath(data, 'missing.field'), undefined);
});

test('resolveExpressionValue preserves raw types and interpolates strings', () => {
	const ctx = makeContext();
	assert.equal(resolveExpressionValue('{{ $json.userId }}', ctx), 42);
	assert.deepEqual(resolveExpressionValue('{{ $json.ids }}', ctx), [10, 20, 30]);
	assert.equal(
		resolveExpressionValue('{{ $pipeline.fetchUser.data[0].id }}', ctx),
		99,
	);
	assert.equal(resolveExpressionValue('{{ $prev.data[0].org_id }}', ctx), 7);
	assert.equal(resolveExpressionValue('{{ $steps[0].data[0].roles[0] }}', ctx), 'admin');
	assert.equal(
		interpolateSqlExpressions(
			'SELECT * FROM orders WHERE org_id = {{ $pipeline.fetchUser.data[0].org_id }}',
			ctx,
		),
		'SELECT * FROM orders WHERE org_id = 7',
	);
});

test('rewritePlaceholders adapts ? per dialect while skipping literals and comments', () => {
	const sql = "SELECT '?' AS q, id FROM users WHERE a = ? AND b = ? -- ignore ?";
	assert.equal(
		rewritePlaceholders('postgres', sql),
		"SELECT '?' AS q, id FROM users WHERE a = $1 AND b = $2 -- ignore ?",
	);
	assert.equal(
		rewritePlaceholders('sqlserver', sql),
		"SELECT '?' AS q, id FROM users WHERE a = @p0 AND b = @p1 -- ignore ?",
	);
	assert.equal(
		rewritePlaceholders('oracle', sql),
		"SELECT '?' AS q, id FROM users WHERE a = :1 AND b = :2 -- ignore ?",
	);
	assert.equal(rewritePlaceholders('mysql', sql), sql);
	assert.equal(rewritePlaceholders('sqlite', sql), sql);
});

test('buildSqlAndBindings binds typed values, expands IN (?) arrays, and guards unsafe SQL', () => {
	const ctx = makeContext();
	const compiled = buildSqlAndBindings(
		'SELECT * FROM t WHERE org_id = ? AND id IN (?) AND active = ?',
		[
			{ type: 'number', value: '{{ $pipeline.fetchUser.data[0].org_id }}' },
			{ type: 'number', value: '{{ $json.ids }}' },
			{ type: 'boolean', value: 'true' },
		],
		false,
		'postgres',
		ctx,
	);
	assert.equal(
		compiled.sql,
		'SELECT * FROM t WHERE org_id = $1 AND id IN ($2,$3,$4) AND active = $5',
	);
	assert.deepEqual(compiled.values, [7, 10, 20, 30, true]);

	assert.throws(
		() =>
			buildSqlAndBindings(
				'SELECT ? FROM t',
				[{ type: 'sql', value: 'NOW()' }],
				false,
				'postgres',
				ctx,
			),
		/Allow Unsafe SQL/,
	);

	const allowed = buildSqlAndBindings(
		'SELECT ? AS ts FROM t',
		[{ type: 'sql', value: 'CURRENT_TIMESTAMP' }],
		true,
		'postgres',
		ctx,
	);
	assert.equal(allowed.sql, 'SELECT CURRENT_TIMESTAMP AS ts FROM t');
	assert.deepEqual(allowed.values, []);
});

test('buildSqlAndBindings returns emptyArrayGuard for empty array IN (?) and errors on mismatch', () => {
	const ctx: SqlPipelineContext = {
		json: { ids: [] },
		pipeline: {},
		steps: [],
		itemIndex: 0,
	};
	const emptyRes = buildSqlAndBindings(
		'SELECT * FROM t WHERE id IN (?)',
		[{ type: 'number', value: '{{ $json.ids }}' }],
		false,
		'sqlite',
		ctx,
	);
	assert.equal(emptyRes.emptyArrayGuard, true);

	assert.throws(
		() =>
			buildSqlAndBindings(
				'SELECT * FROM t WHERE a = ? AND b = ?',
				[{ type: 'string', value: 'onlyOne' }],
				false,
				'sqlite',
				ctx,
			),
		/SQL parameter count mismatch/,
	);
});
