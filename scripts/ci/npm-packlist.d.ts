declare module "npm-packlist" {
  // The checker walks standalone staged packages with no bundled dependency tree.
  export default function packlist(tree: {
    path: string;
    package: { files?: string[]; main?: string; browser?: string; bin?: Record<string, string> };
    isProjectRoot: true;
  }): Promise<string[]>;
}
