/** Bun's file loader resolves unrecognized imports to a URL string. */
declare module "*.svg" {
  const url: string;
  export default url;
}
