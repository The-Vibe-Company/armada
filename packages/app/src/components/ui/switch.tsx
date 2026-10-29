// shadcn's Switch (base-nova style, Base UI), copied in and set on the v7
// tokens: a track on the hairline's well, lime when on (the direction's accent).
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center rounded-full bg-track p-0.5 shadow-ring outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue data-checked:bg-lime data-disabled:cursor-default data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block size-3.5 rounded-full bg-text-2 transition-transform ease-out data-checked:translate-x-3.5 data-checked:bg-side"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
