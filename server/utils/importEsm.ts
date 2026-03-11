/**
 * Load an ESM-only dependency from the CommonJS server build without
 * TypeScript rewriting `import()` to `require()`.
 */
const nativeImport = new Function('specifier', 'return import(specifier);') as <
  T
>(
  specifier: string
) => Promise<T>;

export const importEsm = <T>(specifier: string): Promise<T> =>
  nativeImport<T>(specifier);
