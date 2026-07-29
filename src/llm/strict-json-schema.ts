interface JsonSchemaObject {
  readonly $schema?: string;
  readonly $ref?: string;
  readonly $defs?: Record<string, JsonSchemaObject>;
  readonly type?: string | readonly string[];
  readonly properties?: Record<string, JsonSchemaObject>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchemaObject;
  readonly items?: JsonSchemaObject | JsonSchemaObject[];
  readonly allOf?: readonly JsonSchemaObject[];
  readonly anyOf?: readonly JsonSchemaObject[];
  readonly oneOf?: readonly JsonSchemaObject[];
  readonly if?: JsonSchemaObject;
  readonly then?: JsonSchemaObject;
  readonly else?: JsonSchemaObject;
  readonly not?: JsonSchemaObject;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly default?: unknown;
  readonly title?: string;
  readonly pattern?: string;
}

export function openAiCompatibleJsonSchema(schema: unknown): unknown {
  return removeOpenAiUnsupportedPatterns(schema);
}

export function strictifyJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  return strictifyJsonSchemaNode(schema as JsonSchemaObject);
}

function strictifyJsonSchemaNode(schema: JsonSchemaObject): JsonSchemaObject {
  let result = strictifySubschemas(schema);

  if (result.properties && typeof result.properties === 'object') {
    const properties = result.properties;
    const existingRequired = new Set(result.required ?? []);
    const newProperties = Object.fromEntries(
      Object.entries(properties).map(([name, propertySchema]) => {
        let strictProperty = strictifyJsonSchemaNode(propertySchema);
        if (!existingRequired.has(name)) {
          strictProperty = addNullAlternative(strictProperty);
        }
        return [name, strictProperty];
      }),
    );

    const { default: _default, ...resultWithoutDefault } = result;
    result = {
      ...resultWithoutDefault,
      properties: newProperties,
      required: Object.keys(newProperties),
      additionalProperties: false,
      type: result.type ?? 'object',
    };
  }

  return result;
}

function strictifySubschemas(schema: JsonSchemaObject): JsonSchemaObject {
  let result = strictifyDefs(schema);
  result = strictifyCompositionKeywords(result);
  result = strictifyItems(result);
  result = strictifyConditionalKeywords(result);
  return strictifyAdditionalPropertiesSchema(result);
}

function strictifyDefs(schema: JsonSchemaObject): JsonSchemaObject {
  if (!schema.$defs || typeof schema.$defs !== 'object') {
    return schema;
  }

  return {
    ...schema,
    $defs: Object.fromEntries(
      Object.entries(schema.$defs).map(([name, defSchema]) => [
        name,
        strictifyJsonSchemaNode(defSchema),
      ]),
    ),
  };
}

function strictifyCompositionKeywords(schema: JsonSchemaObject): JsonSchemaObject {
  let result = schema;
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = result[key];
    if (!Array.isArray(branches)) {
      continue;
    }

    result = {
      ...result,
      [key]: branches.map((branch) => strictifyJsonSchemaNode(branch)),
    };
  }

  return result;
}

function strictifyItems(schema: JsonSchemaObject): JsonSchemaObject {
  const { items } = schema;
  if (!items) {
    return schema;
  }

  if (Array.isArray(items)) {
    return {
      ...schema,
      items: items.map((item) => strictifyJsonSchemaNode(item)),
    };
  }

  if (!Array.isArray(items)) {
    return {
      ...schema,
      items: strictifyJsonSchemaNode(items),
    };
  }

  return schema;
}

function strictifyConditionalKeywords(schema: JsonSchemaObject): JsonSchemaObject {
  let result = schema;
  for (const key of ['if', 'then', 'else', 'not'] as const) {
    const nested = result[key];
    if (!nested || typeof nested !== 'object') {
      continue;
    }

    result = {
      ...result,
      [key]: strictifyJsonSchemaNode(nested),
    };
  }

  return result;
}

function strictifyAdditionalPropertiesSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const { additionalProperties } = schema;
  if (
    !additionalProperties ||
    typeof additionalProperties !== 'object' ||
    Array.isArray(additionalProperties)
  ) {
    return schema;
  }

  return {
    ...schema,
    additionalProperties: strictifyJsonSchemaNode(additionalProperties),
  };
}

function addNullAlternative(schema: JsonSchemaObject): JsonSchemaObject {
  const { default: _default, ...withoutDefault } = schema;

  if (isNullableSchema(withoutDefault)) {
    return withoutDefault;
  }

  if (withoutDefault.const !== undefined) {
    return { anyOf: [withoutDefault, { type: 'null' }] };
  }

  if (Array.isArray(withoutDefault.enum)) {
    return withoutDefault.enum.includes(null)
      ? withoutDefault
      : { ...withoutDefault, enum: [...withoutDefault.enum, null] };
  }

  if (typeof withoutDefault.$ref === 'string' && Object.keys(withoutDefault).length === 1) {
    return { anyOf: [{ $ref: withoutDefault.$ref }, { type: 'null' }] };
  }

  if (typeof withoutDefault.type === 'string') {
    return { ...withoutDefault, type: [withoutDefault.type, 'null'] };
  }

  if (Array.isArray(withoutDefault.type)) {
    return withoutDefault.type.includes('null')
      ? withoutDefault
      : { ...withoutDefault, type: [...withoutDefault.type, 'null'] };
  }

  return { anyOf: [withoutDefault, { type: 'null' }] };
}

function isNullableSchema(schema: JsonSchemaObject): boolean {
  if (schema.type === 'null') {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    return true;
  }

  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    return true;
  }

  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some((branch) => branch.type === 'null')) {
      return true;
    }
  }

  return false;
}

function removeOpenAiUnsupportedPatterns(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => removeOpenAiUnsupportedPatterns(entry));
  }

  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (key === 'pattern' && typeof value === 'string' && containsRegexLookaround(value)) {
        return [];
      }
      return [[key, removeOpenAiUnsupportedPatterns(value)]];
    }),
  );
}

function containsRegexLookaround(pattern: string): boolean {
  return /\(\?(?:[=!]|<[=!])/.test(pattern);
}
