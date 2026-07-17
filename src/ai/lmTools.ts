import * as vscode from 'vscode';
import { DbClientManager } from '../db/clientManager';
import { isReadOnlyStatement, splitSqlStatements } from '../sql/statements';
import { ConnectionStore } from '../state/connectionStore';
import { ConnectionMeta } from '../types';

const QUERY_ROW_CAP = 100;

/**
 * Language-model tools: Copilot/Claude chat in VS Code can list schemas,
 * describe tables, and run read-only queries against the user's connections.
 * Tool metadata (descriptions, input schemas) lives in package.json under
 * `contributes.languageModelTools`.
 */
export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  connectionStore: ConnectionStore,
  clientManager: DbClientManager,
): void {
  // Older hosts without the LM tools API just skip registration.
  if (!('lm' in vscode) || typeof vscode.lm.registerTool !== 'function') {
    return;
  }

  const resolve = (nameOrId: string | undefined) => resolveConnection(connectionStore, nameOrId);

  context.subscriptions.push(
    vscode.lm.registerTool<{ connection?: string }>('openvsdb_listSchemas', {
      async invoke(options) {
        const resolved = await resolve(options.input.connection);
        if (typeof resolved === 'string') {
          return textResult(resolved);
        }

        const client = await clientManager.getClient(resolved.id);
        const lines: string[] = [`Connection "${resolved.name}" (${resolved.type}):`];
        for (const schema of await client.listSchemas()) {
          const objects = await client.listObjects(schema);
          const tables = objects.filter((object) => object.type === 'table').map((object) => object.name);
          const views = objects.filter((object) => object.type === 'view').map((object) => object.name);
          lines.push(`- schema ${schema}: tables [${tables.join(', ')}]` + (views.length ? `, views [${views.join(', ')}]` : ''));
        }
        return textResult(lines.join('\n'));
      },
    }),

    vscode.lm.registerTool<{ connection?: string; schema?: string; table: string }>(
      'openvsdb_describeTable',
      {
        async invoke(options) {
          const resolved = await resolve(options.input.connection);
          if (typeof resolved === 'string') {
            return textResult(resolved);
          }

          const client = await clientManager.getClient(resolved.id);
          const schema = options.input.schema ?? defaultSchema(resolved);
          const info = await client.getTableInfo(schema, options.input.table, 'table');

          const lines = [
            `${info.schema}.${info.name} (${info.objectType}) on "${resolved.name}":`,
            ...info.columns.map((column) => {
              const flags = [
                column.isPrimaryKey ? 'PK' : undefined,
                column.isUniqueKey && !column.isPrimaryKey ? 'UNIQUE' : undefined,
                column.isAutoIncrement ? 'AUTO_INCREMENT' : undefined,
                column.nullable ? 'NULL' : 'NOT NULL',
              ].filter(Boolean);
              return `- ${column.name}: ${column.dataType} ${flags.join(' ')}`;
            }),
          ];

          try {
            lines.push('', 'DDL:', await client.getDdl(info.schema, info.name, info.objectType));
          } catch {
            // DDL is best-effort; the column list already answers most questions.
          }

          return textResult(lines.join('\n'));
        },
      },
    ),

    vscode.lm.registerTool<{ connection?: string; sql: string }>('openvsdb_query', {
      prepareInvocation(options) {
        return {
          invocationMessage: 'Running read-only SQL query',
          confirmationMessages: {
            title: 'Run read-only query',
            message: new vscode.MarkdownString(
              `Run against **${options.input.connection ?? 'the default connection'}**:\n\n\`\`\`sql\n${options.input.sql}\n\`\`\``,
            ),
          },
        };
      },
      async invoke(options) {
        const resolved = await resolve(options.input.connection);
        if (typeof resolved === 'string') {
          return textResult(resolved);
        }

        const statements = splitSqlStatements(options.input.sql);
        if (statements.length !== 1 || !isReadOnlyStatement(statements[0])) {
          return textResult(
            'Rejected: only a single read-only statement (SELECT / WITH…SELECT / EXPLAIN / SHOW / DESCRIBE) is allowed here.',
          );
        }

        const client = await clientManager.getClient(resolved.id);
        const [result] = await client.executeRaw(statements[0]);
        if (!result || result.columns.length === 0) {
          return textResult('The statement returned no result set.');
        }

        const rows = result.rows.slice(0, QUERY_ROW_CAP);
        const lines = [
          `| ${result.columns.join(' | ')} |`,
          `| ${result.columns.map(() => '---').join(' | ')} |`,
          ...rows.map((row) => `| ${row.map((value) => (value === null ? 'NULL' : String(value))).join(' | ')} |`),
        ];
        if (result.rows.length > rows.length) {
          lines.push('', `(truncated: showing ${rows.length} of ${result.rows.length} rows)`);
        }
        lines.push('', `${result.rowCount} row(s) in ${result.durationMs}ms on "${resolved.name}".`);

        return textResult(lines.join('\n'));
      },
    }),
  );
}

/**
 * Find the connection a tool call refers to. With one saved connection it is
 * implicit; otherwise an unmatched or missing name returns instructions (as a
 * string) that the model can act on.
 */
async function resolveConnection(
  store: ConnectionStore,
  nameOrId: string | undefined,
): Promise<ConnectionMeta | string> {
  const connections = await store.listConnections();
  if (connections.length === 0) {
    return 'No database connections are configured in OpenVSDB.';
  }

  if (!nameOrId) {
    if (connections.length === 1) {
      return connections[0];
    }
    return `Multiple connections exist — call again with "connection" set to one of: ${connections
      .map((connection) => `"${connection.name}"`)
      .join(', ')}.`;
  }

  const needle = nameOrId.toLowerCase();
  const match = connections.find(
    (connection) => connection.id === nameOrId || connection.name.toLowerCase() === needle,
  );
  if (!match) {
    return `No connection named "${nameOrId}". Available: ${connections
      .map((connection) => `"${connection.name}"`)
      .join(', ')}.`;
  }
  return match;
}

function defaultSchema(connection: ConnectionMeta): string {
  return connection.type === 'mysql' ? connection.database : 'main';
}

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
