// Vite's ?raw imports, used by schema-version.test.ts to read the schema modules' source.
declare module '*?raw' {
  const source: string;
  export default source;
}
