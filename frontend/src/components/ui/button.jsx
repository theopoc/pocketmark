// shadcn/ui's open-code Button pattern, with Pocketmark's authored variants.
// https://ui.shadcn.com/docs/components/button (MIT)
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva("", {
  variants: {
    variant: {
      default: "button primary",
      outline: "button subtle",
      ghost: "text-button",
      destructive: "button danger",
      unstyled: "",
    },
    size: { default: "", icon: "icon-button" },
  },
  defaultVariants: { variant: "unstyled", size: "default" },
});

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
