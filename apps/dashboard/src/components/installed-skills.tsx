import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { installedSkills } from "@/lib/skills";

/** Receipts belong to the authorized sandbox interior, never its organization-wide metadata view. */
export function InstalledSkills({ receipts }: { receipts: unknown }) {
  const skills = installedSkills(receipts);
  if (!skills.length) return null;
  return (
    <Card className="gap-3 py-5">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Installed skills</CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        <ul aria-label="Installed skills" className="space-y-4">
          {skills.map((skill) => (
            <li key={`${skill.reference}@${skill.version}`} className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-all text-sm font-medium">{skill.reference}</span>
                <Badge variant="outline" className="text-[10px] font-normal">
                  {skill.visibility === "public" ? "Public" : "Private"}
                </Badge>
              </div>
              <p className="font-mono text-xs text-muted-foreground">{skill.version}</p>
              {(skill.checksum || skill.origin) && (
                <details className="text-xs text-muted-foreground">
                  <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                    Installation details
                  </summary>
                  <dl className="mt-2 space-y-2 break-all">
                    {skill.origin && (
                      <div>
                        <dt>Source</dt>
                        <dd>{skill.origin}</dd>
                      </div>
                    )}
                    {skill.checksum && (
                      <div>
                        <dt>Checksum</dt>
                        <dd className="font-mono">{skill.checksum}</dd>
                      </div>
                    )}
                  </dl>
                </details>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
