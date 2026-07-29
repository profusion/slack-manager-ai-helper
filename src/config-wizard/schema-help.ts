import configSchema from '../../schemas/config.schema.json' with { type: 'json' };

type JsonSchemaNode = {
  readonly description?: string;
  readonly properties?: Record<string, JsonSchemaNode>;
  readonly $defs?: Record<string, JsonSchemaNode>;
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly items?: JsonSchemaNode;
  readonly $ref?: string;
};

const schema = configSchema as JsonSchemaNode;

export function schemaDescription(path: readonly string[]): string | undefined {
  return findSchemaNode(schema, path)?.description;
}

function findSchemaNode(
  node: JsonSchemaNode | undefined,
  path: readonly string[],
): JsonSchemaNode | undefined {
  const resolved = resolveRef(node);
  if (!resolved || path.length === 0) {
    return resolved;
  }

  const [head, ...tail] = path;
  if (!head) {
    return resolved;
  }
  if (head === '[]') {
    return findSchemaNode(resolved.items, tail);
  }

  const property = resolved.properties?.[head];
  if (property) {
    return findSchemaNode(property, tail);
  }

  for (const option of resolved.oneOf ?? []) {
    const found = findSchemaNode(option, path);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function resolveRef(node: JsonSchemaNode | undefined): JsonSchemaNode | undefined {
  if (!node?.$ref) {
    return node;
  }

  const prefix = '#/$defs/';
  if (!node.$ref.startsWith(prefix)) {
    return node;
  }

  return schema.$defs?.[node.$ref.slice(prefix.length)] ?? node;
}
