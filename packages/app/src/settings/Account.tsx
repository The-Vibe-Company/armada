import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection } from "./Layout";

/** Settings' Account: the sign-in to Armada web, its place kept until THE-2071 builds it. */
export function Account() {
  return (
    <SettingsSection title="Armada">
      <SettingsRow
        title="Sign in to Armada"
        description="The sign-in armada login does, kept on this device so the app and the CLI share it."
        status={<span className="text-text-3">Coming with THE-2071</span>}
        control={<Button disabled>Sign in</Button>}
      />
    </SettingsSection>
  );
}
