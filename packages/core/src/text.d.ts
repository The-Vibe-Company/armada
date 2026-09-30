// Skill files are imported as text so the published bundle carries them.
declare module "*.md" {
  const text: string;
  export default text;
}
