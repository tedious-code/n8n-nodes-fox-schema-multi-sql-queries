import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import type {
	OutputAggregationMode,
	SqlPipelineContext,
	SqlStepExecutionResult,
} from './types';

function stepToSingleStepItems(
	step: SqlStepExecutionResult | undefined,
	itemIndex: number,
): INodeExecutionData[] {
	if (!step) {
		return [];
	}
	if (!step.success && step.error) {
		return [
			{
				json: {
					alias: step.alias,
					dialect: step.dialect,
					success: false,
					error: step.error,
				},
				pairedItem: { item: itemIndex },
			},
		];
	}

	const rawData = step.data;
	if (Array.isArray(rawData)) {
		return rawData.map((row) => ({
			json:
				typeof row === 'object' && row !== null && !Array.isArray(row)
					? (row as IDataObject)
					: { value: row },
			pairedItem: { item: itemIndex },
		}));
	}

	const json: IDataObject =
		typeof rawData === 'object' && rawData !== null
			? (rawData as IDataObject)
			: { data: rawData ?? null };

	return [
		{
			json,
			pairedItem: { item: itemIndex },
		},
	];
}

function summarizeStep(s: SqlStepExecutionResult): IDataObject {
	return {
		alias: s.alias,
		dialect: s.dialect,
		connection: s.connectionLabel,
		success: s.success,
		rowCount: s.rowCount,
		data: s.data,
		durationMs: s.durationMs,
		...(s.sql !== undefined ? { sql: s.sql } : {}),
		...(s.parameters !== undefined ? { parameters: s.parameters } : {}),
		...(s.error !== undefined ? { error: s.error } : {}),
	};
}

export function formatExecutionOutput(
	context: SqlPipelineContext,
	outputMode: OutputAggregationMode,
	originalItem: INodeExecutionData,
): INodeExecutionData[] {
	switch (outputMode) {
		case 'firstResponse':
			return stepToSingleStepItems(context.steps[0], context.itemIndex);

		case 'lastResponse':
		case 'lastStepOnly':
			return stepToSingleStepItems(
				context.prev ?? context.steps[context.steps.length - 1],
				context.itemIndex,
			);

		case 'allAsArray':
			return [
				{
					json: {
						results: context.steps.map(summarizeStep),
					},
					pairedItem: { item: context.itemIndex },
				},
			];

		case 'splitToItems':
			return context.steps.map((s) => ({
				json: summarizeStep(s),
				pairedItem: { item: context.itemIndex },
			}));

		case 'mergeIntoInput': {
			const merged: IDataObject = { ...originalItem.json };
			for (const s of context.steps) {
				merged[s.alias] = s.success ? s.data : { error: s.error };
			}
			return [
				{
					json: merged,
					pairedItem: { item: context.itemIndex },
				},
			];
		}

		case 'mergeAllToObject':
		case 'allAsObject':
		default: {
			const objOutput: IDataObject = {};
			for (const s of context.steps) {
				objOutput[s.alias] = summarizeStep(s);
			}
			return [
				{
					json: objOutput,
					pairedItem: { item: context.itemIndex },
				},
			];
		}
	}
}
