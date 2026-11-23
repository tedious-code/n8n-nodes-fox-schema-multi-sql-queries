import type { INodeType } from 'n8n-workflow';
import { FoxSchemaMultiSqlQueries } from './nodes/FoxSchemaMultiSqlQueries/FoxSchemaMultiSqlQueries.node';

export const nodeTypes: INodeType[] = [new FoxSchemaMultiSqlQueries()];
