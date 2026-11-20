// rdfjs-inference-engine reads rule files and writes runtimes with node:fs; the playground passes
// the rules itself, so in the browser these are never reached.
const unavailable = (name) => () => {
  throw new Error(`${name} is not available in the browser`);
};
export const existsSync = () => false;
export const readdirSync = unavailable('readdirSync');
export const readFileSync = unavailable('readFileSync');
export const statSync = unavailable('statSync');
export const writeFileSync = unavailable('writeFileSync');
export default { existsSync, readdirSync, readFileSync, statSync, writeFileSync };
