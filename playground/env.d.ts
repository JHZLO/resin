// Example schemas are bundled as text (esbuild's text loader)
declare module "*.erd" {
  const source: string;
  export default source;
}
