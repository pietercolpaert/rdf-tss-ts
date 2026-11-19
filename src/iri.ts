/** Helpers for the IRIs the specification makes: default field properties and point IRIs. */

const encoder = new TextEncoder();

/** Percent-encode the UTF-8 bytes of every character that may not appear as is in a part of an IRI. */
function percentEncode(text: string, allowed: RegExp): string {
  let out = '';
  for (const char of text) {
    if (allowed.test(char)) out += char;
    else for (const byte of encoder.encode(char)) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** RFC 3986 `fragment`: pchar, `/` and `?`. */
const FRAGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const RESERVED_OR_UNRESERVED = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]$/;

/** A column name percent-encoded as a fragment, as the default `{#_name}` of `csvw:propertyUrl` is made. */
export function encodeFragment(text: string): string {
  return percentEncode(text, FRAGMENT);
}

/** The IRI of a field property by default: `<base#columnName>`. */
export function defaultPropertyIri(base: string, columnName: string): string {
  return base.replace(/#.*$/, '') + '#' + encodeFragment(columnName);
}

/** Whether a string is an absolute IRI (it has a scheme). */
export const isAbsoluteIri = (iri: string) => /^[a-z][a-z0-9+.-]*:/i.test(iri);

/** Resolve a (possibly relative) IRI against a base. */
export function resolveIri(iri: string, base?: string): string {
  if (isAbsoluteIri(iri)) return iri;
  if (!base) throw new Error(`the IRI ${JSON.stringify(iri)} is relative and there is no base IRI`);
  return new URL(iri, base).href;
}

const OPERATORS: Record<string, { first: string; separator: string; named: boolean; ifEmpty: string; reserved: boolean }> = {
  '': { first: '', separator: ',', named: false, ifEmpty: '', reserved: false },
  '+': { first: '', separator: ',', named: false, ifEmpty: '', reserved: true },
  '#': { first: '#', separator: ',', named: false, ifEmpty: '', reserved: true },
  '.': { first: '.', separator: '.', named: false, ifEmpty: '', reserved: false },
  '/': { first: '/', separator: '/', named: false, ifEmpty: '', reserved: false },
  ';': { first: ';', separator: ';', named: true, ifEmpty: '', reserved: false },
  '?': { first: '?', separator: '&', named: true, ifEmpty: '=', reserved: false },
  '&': { first: '&', separator: '&', named: true, ifEmpty: '=', reserved: false },
};

/**
 * Expand a URI template (RFC 6570, up to level 4) whose variables are texts. An undefined
 * variable is left out, as RFC 6570 says.
 */
export function expandTemplate(template: string, variables: Record<string, string | undefined>): string {
  return template.replace(/\{([^}]*)\}/g, (_, expression: string) => {
    const operator = /^[+#./;?&]/.test(expression) ? expression[0] : '';
    const spec = OPERATORS[operator];
    const parts: string[] = [];
    for (const raw of expression.slice(operator.length).split(',')) {
      const match = /^([A-Za-z0-9_.%-]+)(?::(\d+)|\*)?$/.exec(raw.trim());
      if (!match) throw new Error(`the URI template ${JSON.stringify(template)} has an invalid variable ${JSON.stringify(raw)}`);
      const name = decodeURIComponent(match[1]);
      let value = variables[name];
      if (value === undefined) continue;
      if (match[2]) value = [...value].slice(0, Number(match[2])).join('');
      const encoded = percentEncode(value, spec.reserved ? RESERVED_OR_UNRESERVED : UNRESERVED);
      parts.push(spec.named ? (value === '' ? match[1] + spec.ifEmpty : `${match[1]}=${encoded}`) : encoded);
    }
    return parts.length ? spec.first + parts.join(spec.separator) : '';
  });
}
