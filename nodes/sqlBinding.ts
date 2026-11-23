import { NodeOperationError, type INode } from 'n8n-workflow';
import {
	placeholderStyleFor,
	renderPlaceholder,
	sqlReadingsFor,
	sqlTokens,
} from './foxSchema';
import type { SupportedDialect } from './supportedDialects';
import type { BindingParam, SqlPipelineContext } from './types';
import { resolveExpressionValue } from './expressionResolver';

const FALLBACK_NODE: INode = {
	id: 'fox-schema-multi-sql',
	name: 'Fox Schema Multi SQL Queries',
	type: 'foxSchemaMultiSqlQueries',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function isSqlExpression(value: unknown): value is { __sql: string } {
	return typeof value === 'object' && value !== null && '__sql' in value;
}

export function rewritePlaceholders(dialect: SupportedDialect, sql: string): string {
	const style = placeholderStyleFor(dialect);
	if (style === 'question') {
		return sql;
	}

	const reading = sqlReadingsFor(sql, dialect)[0] ?? {};
	let index = 0;
	let out = '';

	for (const token of sqlTokens(sql, reading)) {
		const raw = sql.slice(token.start, token.end);
		if (token.kind === 'punct' && raw === '?') {
			index += 1;
			out += renderPlaceholder(style, index);
		} else {
			out += raw;
		}
	}

	return out;
}

export function convertBindingValue(
	param: BindingParam,
	allowUnsafeSql: boolean,
	context: SqlPipelineContext,
	node: INode = FALLBACK_NODE,
): unknown {
	const resolved =
		typeof param.value === 'string'
			? resolveExpressionValue(param.value, context)
			: param.value;

	if (Array.isArray(resolved)) {
		if (param.type === 'json') {
			return JSON.stringify(resolved);
		}
		return resolved;
	}

	if (typeof resolved === 'string' && resolved.startsWith('__ARRAY__:')) {
		try {
			return JSON.parse(resolved.slice('__ARRAY__:'.length));
		} catch {
			throw new NodeOperationError(node, 'Invalid __ARRAY__ parameter payload');
		}
	}

	switch (param.type) {
		case 'number': {
			if (resolved === null || resolved === undefined || resolved === '') {
				return null;
			}
			const num = Number(resolved);
			if (Number.isNaN(num)) {
				throw new NodeOperationError(
					node,
					`Binding value "${resolved}" is not a valid number`,
				);
			}
			return num;
		}
		case 'boolean': {
			if (typeof resolved === 'boolean') return resolved;
			const s = String(resolved ?? '').trim().toLowerCase();
			return s === 'true' || s === '1' || s === 'yes';
		}
		case 'date': {
			if (resolved instanceof Date) return resolved;
			const d = new Date(String(resolved ?? ''));
			if (Number.isNaN(d.getTime())) {
				throw new NodeOperationError(
					node,
					`Invalid date binding value: "${resolved}"`,
				);
			}
			return d;
		}
		case 'null':
			return null;
		case 'json':
			return typeof resolved === 'string' ? resolved : JSON.stringify(resolved ?? null);
		case 'sql':
			if (!allowUnsafeSql) {
				throw new NodeOperationError(
					node,
					'SQL Expression parameters require "Allow Unsafe SQL" to be enabled.',
				);
			}
			return { __sql: String(resolved ?? '') };
		case 'string':
		default:
			if (resolved === null || resolved === undefined) return '';
			return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
	}
}

export interface CompiledSqlQuery {
	sql: string;
	values: any[];
	emptyArrayGuard?: boolean;
}

export function buildSqlAndBindings(
	sql: string,
	params: BindingParam[],
	allowUnsafeSql: boolean,
	dialect: SupportedDialect,
	context: SqlPipelineContext,
	node: INode = FALLBACK_NODE,
): CompiledSqlQuery {
	const converted = params.map((p) =>
		convertBindingValue(p, allowUnsafeSql, context, node),
	);
	const reading = sqlReadingsFor(sql, dialect)[0] ?? {};
	const values: any[] = [];
	let finalSql = '';
	let placeholderCount = 0;
	let paramIdx = 0;

	for (const token of sqlTokens(sql, reading)) {
		const raw = sql.slice(token.start, token.end);
		if (token.kind !== 'punct' || raw !== '?') {
			finalSql += raw;
			continue;
		}

		placeholderCount += 1;
		if (paramIdx >= converted.length) {
			paramIdx += 1;
			finalSql += raw;
			continue;
		}

		const val = converted[paramIdx++];
		if (Array.isArray(val)) {
			if (val.some((v) => isSqlExpression(v))) {
				throw new NodeOperationError(
					node,
					'SQL Expression is not allowed inside an array IN (?) parameter',
				);
			}
			if (val.length === 0) {
				return { sql, values: [], emptyArrayGuard: true };
			}
			finalSql += val.map(() => '?').join(',');
			values.push(...val);
			continue;
		}

		if (isSqlExpression(val)) {
			finalSql += val.__sql;
			continue;
		}

		finalSql += '?';
		values.push(val);
	}

	if (placeholderCount !== converted.length) {
		throw new NodeOperationError(
			node,
			[
				'SQL parameter count mismatch',
				`Expected ? placeholders: ${placeholderCount}`,
				`Provided parameters: ${converted.length}`,
				`SQL: ${sql}`,
			].join('\n'),
		);
	}

	return {
		sql: rewritePlaceholders(dialect, finalSql),
		values,
	};
}
