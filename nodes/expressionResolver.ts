import type { SqlPipelineContext } from './types';

/**
 * Safely extracts a nested property using dot/bracket notation,
 * e.g., "data[0].id", "0.email", "user.roles[1]".
 */
export function extractByPath(source: any, path?: string): any {
	if (!path || path.trim() === '' || source === null || source === undefined) {
		return source;
	}

	const cleanPath = path.trim().replace(/^(\$json\.|\$response\.|\$data\.)/, '');
	const segments = cleanPath
		.replace(/\[(\w+)\]/g, '.$1')
		.split('.')
		.filter(Boolean);

	let current = source;
	for (const segment of segments) {
		if (current === null || current === undefined) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

/**
 * Resolves a single expression token against the pipeline runtime context.
 * Supports:
 * - $json / $json.<path>
 * - $pipeline / $pipeline.<alias>.<path>
 * - $steps[<index>] / $steps[<index>].<path>
 * - $prev / $prev.<path>
 * - $itemIndex
 */
export function resolveSingleToken(rawExpr: string, context: SqlPipelineContext): any {
	const expr = rawExpr.trim();

	if (expr === '$json') {
		return context.json;
	}
	if (expr.startsWith('$json.')) {
		return extractByPath(context.json, expr.slice(6));
	}

	if (expr === '$pipeline') {
		return context.pipeline;
	}
	if (expr.startsWith('$pipeline.')) {
		const remainder = expr.slice(10);
		const firstDot = remainder.indexOf('.');
		const bracketIdx = remainder.indexOf('[');
		const splitIdx =
			firstDot === -1
				? bracketIdx
				: bracketIdx === -1
					? firstDot
					: Math.min(firstDot, bracketIdx);

		if (splitIdx === -1) {
			return context.pipeline[remainder];
		}
		const alias = remainder.slice(0, splitIdx);
		const subpath = remainder[splitIdx] === '.'
			? remainder.slice(splitIdx + 1)
			: remainder.slice(splitIdx);
		const stepResult = context.pipeline[alias];
		return stepResult ? extractByPath(stepResult, subpath) : undefined;
	}

	const stepsMatch = expr.match(/^\$steps\[(\d+)\](?:\.?(.+))?$/);
	if (stepsMatch) {
		const index = parseInt(stepsMatch[1], 10);
		const stepResult = context.steps[index];
		if (!stepResult) return undefined;
		const subpath = stepsMatch[2];
		return subpath ? extractByPath(stepResult, subpath) : stepResult;
	}

	if (expr === '$prev') {
		return context.prev;
	}
	if (expr.startsWith('$prev.')) {
		return context.prev ? extractByPath(context.prev, expr.slice(6)) : undefined;
	}

	if (expr === '$itemIndex') {
		return context.itemIndex;
	}

	return extractByPath(context.json, expr);
}

/**
 * Resolves template expressions inside a binding value.
 * If the entire string is a single `{{ ... }}` token, preserves its raw JS type
 * (number, boolean, array, object, null) so SQL bindings keep typed values.
 */
export function resolveExpressionValue(input: string, context: SqlPipelineContext): any {
	const trimmed = input.trim();
	const singleMatch = trimmed.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
	if (singleMatch) {
		return resolveSingleToken(singleMatch[1], context);
	}

	return interpolateSqlExpressions(input, context);
}

/**
 * Interpolates `{{ ... }}` tokens into a SQL string or mixed string.
 */
export function interpolateSqlExpressions(input: string, context: SqlPipelineContext): string {
	return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, expression) => {
		const val = resolveSingleToken(expression, context);
		if (val === undefined || val === null) {
			return '';
		}
		if (typeof val === 'object') {
			try {
				return JSON.stringify(val);
			} catch {
				return String(val);
			}
		}
		return String(val);
	});
}
