/**
 * A small syntax highlighter for Turtle and TriG, with the RDF Messages keywords (`VERSION`,
 * `MESSAGE`, `@message`): enough to read the metadata and the expansion of a source, without a
 * dependency. Returns HTML with a `<span class="tk-…">` around each token.
 */

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Tried in this order at every position: the first that matches is the token. */
const TOKENS: [string, RegExp][] = [
  // a string, with its language tag or datatype: before comments and IRIs, which may hold the same characters
  ['string', /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y],
  ['iri', /<[^<>"{}|^`\\\s]*>/y],
  ['comment', /#[^\n]*/y],
  ['keyword', /@(?:prefix|base|version|message)\b|\b(?:PREFIX|BASE|VERSION|MESSAGE|GRAPH)\b/y],
  ['lang', /@[a-zA-Z]+(?:-[a-zA-Z0-9]+)*/y],
  ['bnode', /_:[\w.-]*\w/y],
  // a prefixed name: also `xsd:dateTime` after ^^
  ['pname', /[A-Za-z][\w.-]*?:(?:[\w%-]|\.(?=[\w%-]))*|:(?:[\w%-]|\.(?=[\w%-]))*/y],
  // `82.` is the number 82 and the end of a statement
  ['number', /[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y],
  ['keyword', /\b(?:a|true|false)\b/y],
  ['punct', /\^\^|[;,.[\]()]/y],
];

export function highlightTurtle(text: string): string {
  let out = '';
  let plain = '';
  let at = 0;
  while (at < text.length) {
    let matched = false;
    for (const [kind, pattern] of TOKENS) {
      pattern.lastIndex = at;
      const match = pattern.exec(text);
      if (!match || match[0] === '') continue;
      out += esc(plain) + `<span class="tk-${kind}">${esc(match[0])}</span>`;
      plain = '';
      at += match[0].length;
      matched = true;
      break;
    }
    if (!matched) plain += text[at++];
  }
  return out + esc(plain);
}
