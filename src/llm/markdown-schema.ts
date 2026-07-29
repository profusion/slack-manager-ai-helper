export function extractJsonSchemaBlock(markdown: string): unknown | undefined {
  const match = /```jsonschema\s*([\s\S]*?)```/iu.exec(markdown);
  if (!match?.[1]) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('jsonschema fenced block must contain a JSON object');
  }

  return parsed;
}

export function minifyJsonFencedBlocks(markdown: string): string {
  return markdown.replaceAll(
    /```(jsonschema|json)([^\n]*)\n([\s\S]*?)```/giu,
    (_block: string, language: string, suffix: string, body: string) => {
      const parsed: unknown = JSON.parse(body.trim());
      const normalizedLanguage = language.toLowerCase();
      return `\`\`\`${normalizedLanguage}${suffix}\n${JSON.stringify(parsed)}\n\`\`\``;
    },
  );
}

export function stripJsonSchemaFencedBlocks(markdown: string): string {
  return markdown.replaceAll(/```jsonschema[^\n]*\n[\s\S]*?```\n?/giu, '');
}

export function extractJsonFromText(text: string): unknown {
  const fenced = /```json\s*([\s\S]*?)```/iu.exec(text);
  const candidate = fenced?.[1] ?? text;
  return JSON.parse(candidate.trim());
}

export function extractMemorySection(text: string): string | null {
  const headed =
    /(?:^|\n)#{1,6}\s*MEMORY\s*\n([\s\S]*?)(?=\n---\s*(?:\n|$)|\n#{1,6}\s*(?:ANALYSIS|REPORT)\b|\s*$)/iu.exec(
      text,
    );
  if (headed?.[1]?.trim()) {
    return stripOuterJsonFence(headed[1].trim());
  }

  const fenced = /```memory\s*([\s\S]*?)```/iu.exec(text);
  if (fenced?.[1]?.trim()) {
    return fenced[1].trim();
  }

  const labelled = /(?:^|\n)MEMORY:\s*([\s\S]*?)(?:\n(?:ANALYSIS|REPORT):|\s*$)/iu.exec(text);
  return labelled?.[1]?.trim() ? stripOuterJsonFence(labelled[1].trim()) : null;
}

export function extractReportSection(text: string): string | null {
  const headed = /(?:^|\n)#{1,6}\s*(?:ANALYSIS|REPORT)\s*\n([\s\S]*)$/iu.exec(text);
  if (headed?.[1]?.trim()) {
    return headed[1].trim();
  }

  const afterMemoryDelimiter = /(?:^|\n)#{1,6}\s*MEMORY\s*\n[\s\S]*?\n---\s*\n+([\s\S]*)$/iu.exec(
    text,
  );
  if (afterMemoryDelimiter?.[1]?.trim()) {
    return afterMemoryDelimiter[1].trim();
  }

  const labelled = /(?:^|\n)(?:ANALYSIS|REPORT):\s*([\s\S]*)$/iu.exec(text);
  return labelled?.[1]?.trim() ? labelled[1].trim() : null;
}

function stripOuterJsonFence(text: string): string {
  const innerJson = /```(?:json|memory)?\s*([\s\S]*?)```/iu.exec(text);
  if (innerJson?.[1]?.trim()) {
    return innerJson[1].trim();
  }

  const fenced = /^```(?:json|memory)?\s*\n([\s\S]*?)\n```$/iu.exec(text);
  return fenced?.[1]?.trim() ?? text;
}
