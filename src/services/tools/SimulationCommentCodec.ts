import {
  METADATA_LIMITS,
  MetadataValidationError,
  validateProgramOffsets,
  validateProgramSetup,
  validateProgramTool,
} from './SimulationMetadata';
import type {
  ProgramOffsetsDefinition,
  ProgramSetupDefinition,
  ProgramToolDefinition,
} from './SimulationMetadata';

/** Explicit caller-verified standalone comment syntax. Never inferred from highlighting regexes.
 * This is NOT a header placement or machine-conversion capability declaration.
 */
export type SimulationCommentSyntax = (
  { kind: 'line'; prefix: ';' | '//' } | { kind: 'block'; open: '('; close: ')' }
) & { maxLineLength?: number };
export interface MetadataDiagnostic {
  code: 'syntax' | 'invalid' | 'unsupported' | 'limit' | 'conflict';
  message: string;
  /** 1-based source line, when available. */
  line?: number;
}
export interface MetadataSourceBlock {
  /** Original text and UTF-16 half-open offsets, including the final line ending when present. */
  raw: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  version: string;
  kind: string;
  value?: ProgramSetupDefinition | ProgramToolDefinition | ProgramOffsetsDefinition;
}
export interface SimulationMetadataParseResult {
  setup?: ProgramSetupDefinition;
  tools: ProgramToolDefinition[];
  offsets?: ProgramOffsetsDefinition;
  blocks: MetadataSourceBlock[];
  diagnostics: MetadataDiagnostic[];
}

function error(message: string): never {
  throw new MetadataValidationError(message);
}
function validateSyntax(syntax: SimulationCommentSyntax): void {
  if (
    !syntax ||
    !(
      (syntax.kind === 'line' && [';', '//'].includes(syntax.prefix)) ||
      (syntax.kind === 'block' && syntax.open === '(' && syntax.close === ')')
    )
  )
    error('Explicit supported comment syntax is required');
  if (
    syntax.maxLineLength !== undefined &&
    (!Number.isSafeInteger(syntax.maxLineLength) || syntax.maxLineLength < 1)
  ) {
    error('Invalid comment line limit');
  }
}
function wrap(payload: string, syntax: SimulationCommentSyntax): string {
  return syntax.kind === 'line' ? `${syntax.prefix} ${payload}` : `(${payload})`;
}
function unwrap(line: string, syntax: SimulationCommentSyntax): string | undefined {
  const trimmed = line.replace(/[\r\n]+$/, '').trimStart();
  if (syntax.kind === 'line') {
    return trimmed.startsWith(syntax.prefix)
      ? trimmed.slice(syntax.prefix.length).trimStart()
      : undefined;
  }
  const enclosed = trimmed.trimEnd();
  if (!enclosed.startsWith('(') || !enclosed.endsWith(')')) return undefined;
  const inner = enclosed.slice(1, -1);
  // Nested/terminated comments must never be mistaken for one safe payload line.
  return /[()]/.test(inner) ? undefined : inner.trimStart();
}
function setObjectField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
function encodeString(value: string): string {
  return `"${value.replace(
    /["\\();%<>&{}@\u0000-\u001f\u007f-\uffff]/g,
    (char) => `@u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}"`;
}
function encodeMetadataValue(value: unknown, depth = 0): string {
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) error('Metadata number must be finite');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  if (depth + 1 > METADATA_LIMITS.depth) error('Metadata nesting exceeds limit');
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeMetadataValue(item, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined,
    );
    if (entries.length === 0) return '[:]';
    return `[${entries
      .map(([key, item]) => `${encodeString(key)}:${encodeMetadataValue(item, depth + 1)}`)
      .join(',')}]`;
  }
  error('Unsupported metadata value');
}
function boundedJSON(input: string, fieldKey?: string): unknown {
  if (input.length > METADATA_LIMITS.value) error('Metadata value exceeds size limit');
  let pos = 0;
  let depth = 0;
  const skipWhitespace = (): void => {
    while (pos < input.length && (input[pos] === ' ' || input[pos] === '\t' || input[pos] === '\r' || input[pos] === '\n')) {
      pos++;
    }
  };
  const parseString = (): string => {
    if (input[pos] !== '"') error('Expected string');
    pos++;
    let out = '';
    while (pos < input.length) {
      const ch = input[pos++];
      if (ch === '"') return out;
      if (ch === '\\') {
        if (pos >= input.length) error('Unterminated string escape');
        const esc = input[pos++];
        if (esc === 'u') {
          const hex = input.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) error('Invalid unicode escape');
          pos += 4;
          out += String.fromCharCode(parseInt(hex, 16));
        } else if (esc === '"' || esc === '\\' || esc === '/') out += esc;
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else error('Invalid string escape');
      } else if (
        (ch === '@' || ch === ' ') &&
        input[pos] === 'u' &&
        /^[0-9a-fA-F]{4}$/.test(input.slice(pos + 1, pos + 5))
      ) {
        const hex = input.slice(pos + 1, pos + 5);
        pos += 5;
        out += String.fromCharCode(parseInt(hex, 16));
      } else if (ch.charCodeAt(0) < 0x20) {
        error('Invalid control character in string');
      } else {
        out += ch;
      }
    }
    error('Unterminated string');
  };
  const parseUnbracedObject = (firstKey: string): Record<string, unknown> => {
    if (++depth > METADATA_LIMITS.depth) error('Metadata nesting exceeds limit');
    pos++; // consume ':'
    const obj: Record<string, unknown> = {};
    setObjectField(obj, firstKey, parseValue(true));
    while (true) {
      skipWhitespace();
      if (input[pos] !== ',') break;
      pos++;
      skipWhitespace();
      const key = parseString();
      skipWhitespace();
      if (input[pos] !== ':') error('Expected colon after object key');
      pos++;
      setObjectField(obj, key, parseValue(true));
    }
    depth--;
    return obj;
  };
  const parseBracedObject = (): Record<string, unknown> => {
    pos++; // consume '{'
    if (++depth > METADATA_LIMITS.depth) error('Metadata nesting exceeds limit');
    const obj: Record<string, unknown> = {};
    skipWhitespace();
    if (input[pos] === '}') {
      pos++;
      depth--;
      return obj;
    }
    while (true) {
      skipWhitespace();
      const key = parseString();
      skipWhitespace();
      if (input[pos] !== ':') error('Expected colon after object key');
      pos++;
      setObjectField(obj, key, parseValue(false));
      skipWhitespace();
      if (input[pos] === ',') {
        pos++;
        continue;
      }
      if (input[pos] === '}') {
        pos++;
        depth--;
        return obj;
      }
      error('Expected comma or closing brace');
    }
  };
  const parseBracketContainer = (): unknown => {
    pos++; // consume '['
    if (++depth > METADATA_LIMITS.depth) error('Metadata nesting exceeds limit');
    skipWhitespace();
    if (input[pos] === ']') {
      pos++;
      depth--;
      return [];
    }
    if (input[pos] === ':') {
      pos++;
      skipWhitespace();
      if (input[pos] !== ']') error('Invalid empty bracket object');
      pos++;
      depth--;
      return {};
    }
    const first = parseValue(false);
    skipWhitespace();
    if (input[pos] === ':') {
      if (typeof first !== 'string') error('Bracket object key must be a string');
      pos++;
      const obj: Record<string, unknown> = {};
      setObjectField(obj, first, parseValue(true));
      while (true) {
        skipWhitespace();
        if (input[pos] === ',') {
          pos++;
          skipWhitespace();
          const key = parseString();
          skipWhitespace();
          if (input[pos] !== ':') error('Expected colon after bracket object key');
          pos++;
          setObjectField(obj, key, parseValue(true));
          continue;
        }
        if (input[pos] === ']') {
          pos++;
          depth--;
          return obj;
        }
        error('Expected comma or closing bracket in object');
      }
    }
    const arr: unknown[] = [first];
    while (true) {
      skipWhitespace();
      if (input[pos] === ',') {
        pos++;
        arr.push(parseValue(false));
        continue;
      }
      if (input[pos] === ']') {
        pos++;
        depth--;
        return arr;
      }
      error('Expected comma or closing bracket in array');
    }
  };
  const parsePrimitive = (): unknown => {
    if (input.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (input.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (input.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(pos));
    if (!match) error('Invalid metadata value');
    pos += match[0].length;
    return Number(match[0]);
  };
  const parseValue = (allowUnbracedObject: boolean): unknown => {
    skipWhitespace();
    if (pos >= input.length) error('Unexpected end of metadata value');
    const ch = input[pos];
    if (ch === '"') {
      const str = parseString();
      if (allowUnbracedObject) {
        skipWhitespace();
        if (input[pos] === ':') return parseUnbracedObject(str);
      }
      return str;
    }
    if (ch === '[') return parseBracketContainer();
    if (ch === '{') return parseBracedObject();
    return parsePrimitive();
  };
  const parsed = parseValue(true);
  skipWhitespace();
  if (pos !== input.length) error('Unexpected trailing metadata characters');
  if (
    (fieldKey === 'holder' || fieldKey === 'cutting' || fieldKey === 'offsets') &&
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    /^\[\s*"/.test(input.trimStart())
  ) {
    return [parsed];
  }
  return parsed;
}
function encodeJSON(value: unknown): string {
  // Encode objects with CNC-safe square brackets and escape special/non-ASCII chars with @uXXXX (no {, }, or \).
  const encoded = encodeMetadataValue(value);
  boundedJSON(encoded);
  return encoded;
}
function encodeRecord(key: string, value: unknown, syntax: SimulationCommentSyntax): string[] {
  const json = encodeJSON(value);
  const line = wrap(`${key}=${json}`, syntax);
  if (syntax.maxLineLength === undefined || line.length <= syntax.maxLineLength) return [line];
  // Fixed worst-case four-digit numbering leaves deterministic room for every prefix.
  const capacity = syntax.maxLineLength - wrap(`${key}@9999/9999=`, syntax).length;
  if (capacity < 6) error('Comment line limit is too small for safe continuation records');
  const chunks: string[] = [];
  let chunk = '';
  // Treat each @uXXXX or JSON escape as an atomic unit; never split an escape across continuation lines.
  for (const token of json.match(/@u[0-9a-fA-F]{4}|\\u[0-9a-fA-F]{4}|\\.|[^@\\]/g) ?? []) {
    if (chunk.length + token.length > capacity) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += token;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 9999) error('Too many continuation records');
  return chunks.map((part, index) => wrap(`${key}@${index + 1}/${chunks.length}=${part}`, syntax));
}
function decodeRecords(payloads: string[]): Record<string, unknown> {
  const value: Record<string, unknown> = Object.create(null);
  for (let index = 0; index < payloads.length; index++) {
    const match = /^([A-Za-z][A-Za-z0-9]*)(?:@([1-9][0-9]{0,3})\/([1-9][0-9]{0,3}))?=(.*)$/.exec(
      payloads[index],
    );
    if (!match) error('Invalid metadata record');
    const [, key, part, count, initial] = match;
    if (Object.prototype.hasOwnProperty.call(value, key)) error(`Duplicate metadata field: ${key}`);
    let json = initial;
    if (part !== undefined) {
      if (part !== '1' || Number(count) < 2) error('Invalid continuation sequence');
      if (Number(count) > payloads.length - index) error('Incomplete continuation sequence');
      for (let next = 2; next <= Number(count); next++) {
        const prefix = `${key}@${next}/${count}=`;
        const payload = payloads[++index];
        if (!payload.startsWith(prefix)) error('Out-of-order or mixed continuation sequence');
        json += payload.slice(prefix.length);
        if (json.length > METADATA_LIMITS.value) error('Metadata value exceeds size limit');
      }
    }
    value[key] = boundedJSON(json, key);
  }
  return value;
}

/** Pure codec. It returns source spans, never edits documents or executes payloads. */
export class SimulationCommentCodec {
  encodeSetup(
    setup: ProgramSetupDefinition,
    syntax: SimulationCommentSyntax,
    eol: '\n' | '\r\n' = '\n',
  ): string {
    validateProgramSetup(setup);
    return this.encode('SETUP', setup, ['machineName', 'material'], syntax, eol);
  }
  encodeTool(
    tool: ProgramToolDefinition,
    syntax: SimulationCommentSyntax,
    eol: '\n' | '\r\n' = '\n',
  ): string {
    validateProgramTool(tool);
    return this.encode(
      'TOOL',
      tool,
      ['toolNumber', 'description', 'Q', 'R', 'holder', 'cutting', 'orientation', 'turning'],
      syntax,
      eol,
    );
  }
  encodeOffsets(
    offsets: ProgramOffsetsDefinition,
    syntax: SimulationCommentSyntax,
    eol: '\n' | '\r\n' = '\n',
  ): string {
    const validated = validateProgramOffsets(offsets);
    return this.encode('OFFSETS', validated, ['offsetScope', 'offsets'], syntax, eol);
  }
  private encode(
    kind: string,
    value: object,
    keys: string[],
    syntax: SimulationCommentSyntax,
    eol: '\n' | '\r\n',
  ): string {
    validateSyntax(syntax);
    if (eol !== '\n' && eol !== '\r\n') error('Invalid line ending');
    const lines = [wrap(`@NCE-SIM:1 BEGIN ${kind}`, syntax)];
    const fields = value as Record<string, unknown>;
    for (const key of keys)
      if (fields[key] !== undefined) lines.push(...encodeRecord(key, fields[key], syntax));
    lines.push(wrap(`@NCE-SIM:1 END ${kind}`, syntax));
    if (
      syntax.maxLineLength !== undefined &&
      lines.some((line) => line.length > syntax.maxLineLength!)
    ) {
      error('Comment line limit cannot accommodate metadata markers');
    }
    const result = lines.join(eol);
    if (result.length > METADATA_LIMITS.block) error('Metadata block exceeds size limit');
    return result;
  }

  parse(text: string, syntax: SimulationCommentSyntax): SimulationMetadataParseResult {
    const result: SimulationMetadataParseResult = { tools: [], blocks: [], diagnostics: [] };
    try {
      validateSyntax(syntax);
    } catch (cause) {
      result.diagnostics.push({ code: 'syntax', message: String(cause) });
      return result;
    }
    if (text.length > METADATA_LIMITS.document) {
      result.diagnostics.push({ code: 'limit', message: 'Program exceeds metadata parsing limit' });
      return result;
    }
    const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length;
    }
    const seenTools = new Set<number | string>();
    for (let index = 0; index < lines.length; index++) {
      const payload = unwrap(lines[index], syntax);
      if (payload === undefined && /^(?:\(|;|\/\/)?\s*@NCE-SIM:/.test(lines[index].trimStart())) {
        result.diagnostics.push({
          code: 'syntax',
          message: 'Metadata marker is not in the supplied standalone comment syntax',
          line: index + 1,
        });
      }
      if (!payload?.startsWith('@NCE-SIM:')) continue;
      const begin = /^@NCE-SIM:([0-9]+) BEGIN ([A-Z]+)$/.exec(payload.trimEnd());
      if (!begin) {
        result.diagnostics.push({
          code: 'invalid',
          message: 'Unexpected metadata marker',
          line: index + 1,
        });
        continue;
      }
      if (result.blocks.length >= METADATA_LIMITS.blocks) {
        result.diagnostics.push({
          code: 'limit',
          message: 'Too many metadata blocks',
          line: index + 1,
        });
        break;
      }
      const start = index;
      const [, version, kind] = begin;
      const payloads: string[] = [];
      let closed = false;
      let invalidLine = false;
      for (index++; index < lines.length; index++) {
        const next = unwrap(lines[index], syntax);
        if (next?.trimEnd() === `@NCE-SIM:${version} END ${kind}`) {
          closed = true;
          break;
        }
        if (next?.startsWith('@NCE-SIM:') && next.includes(' BEGIN ')) {
          index--;
          break;
        }
        if (next === undefined) invalidLine = true;
        else payloads.push(next);
        if (offsets[index] - offsets[start] > METADATA_LIMITS.block) invalidLine = true;
      }
      const end = Math.min(index, lines.length - 1);
      const endOffset = offsets[end] + lines[end].length;
      const block: MetadataSourceBlock = {
        raw: text.slice(offsets[start], endOffset),
        startOffset: offsets[start],
        endOffset,
        startLine: start + 1,
        endLine: end + 1,
        version,
        kind,
      };
      result.blocks.push(block);
      if (version !== '1' || !['SETUP', 'TOOL', 'OFFSETS'].includes(kind)) {
        result.diagnostics.push({
          code: 'unsupported',
          message: `Unsupported metadata ${version}/${kind}`,
          line: start + 1,
        });
        continue;
      }
      try {
        if (!closed || invalidLine)
          error('Incomplete block or payload outside standalone comments');
        if (block.raw.length > METADATA_LIMITS.block) error('Metadata block exceeds size limit');
        if (
          syntax.maxLineLength !== undefined &&
          lines
            .slice(start, end + 1)
            .some((line) => line.replace(/[\r\n]+$/, '').length > syntax.maxLineLength!)
        ) {
          error('Metadata line exceeds controller limit');
        }
        const value = decodeRecords(payloads);
        if (kind === 'SETUP') {
          const setup = validateProgramSetup(value);
          if (result.setup) error('Duplicate SETUP block');
          block.value = setup;
          result.setup = setup;
        } else if (kind === 'TOOL') {
          const tool = validateProgramTool(value);
          if (seenTools.has(tool.toolNumber)) error('Duplicate tool definition');
          seenTools.add(tool.toolNumber);
          block.value = tool;
          result.tools.push(tool);
        } else {
          const offsets = validateProgramOffsets(value);
          if (result.offsets) error('Duplicate OFFSETS block');
          block.value = offsets;
          result.offsets = offsets;
        }
      } catch (cause) {
        result.diagnostics.push({
          code: 'invalid',
          message: cause instanceof Error ? cause.message : String(cause),
          line: start + 1,
        });
      }
    }
    return result;
  }
}
