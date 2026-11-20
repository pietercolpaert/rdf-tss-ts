// The few functions of node:path that rdfjs-inference-engine imports, for POSIX paths.
export const sep = '/';
export const join = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
export const resolve = (...parts) => join(...parts);
export const relative = (from, to) => (to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to);
export const dirname = (path) => path.replace(/\/[^/]*$/, '') || '/';
export default { sep, join, resolve, relative, dirname };
