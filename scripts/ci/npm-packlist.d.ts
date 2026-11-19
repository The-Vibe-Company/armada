declare module "npm-packlist" {
  export default function packlist(tree: {
    path: string;
    package: { files?: string[]; main?: string; browser?: string; bin?: Record<string, string> };
    isProjectRoot: true;
  }): Promise<string[]>;
}
