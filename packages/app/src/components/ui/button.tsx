// shadcn's Button (base-nova style, Base UI), copied in and set on the v7
// tokens: the dashboard's .btn (a ring, a lit edge, 30 px, scale on press).
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex h-7.5 shrink-0 cursor-pointer select-none items-center justify-center gap-1.75 whitespace-nowrap rounded-control px-3 font-medium text-body transition-[scale,background-color,box-shadow,color] ease-out motion-safe:active:not-disabled:scale-96 disabled:cursor-default disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-fill shadow-control hover:not-disabled:bg-fill-2",
        soft: "bg-card text-text shadow-control hover:not-disabled:bg-panel-3 hover:not-disabled:shadow-control-hover",
        ghost: "text-text-2 hover:text-text",
        primary:
          "bg-text text-bg shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_1px_2px_rgba(0,0,0,0.5)] hover:not-disabled:bg-[#fff]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Button({ className, variant, ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, className }))} {...props} />;
}

export { Button };
