import type { ReactNode } from "react";
import { OttoNavigation } from "./otto-navigation";

export default function OttoLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <OttoNavigation />
      {children}
    </>
  );
}
