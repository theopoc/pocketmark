// shadcn/ui Input; visual rules come from Pocketmark's semantic CSS tokens.
import { cn } from "../../lib/utils";

export function Input({ className, type, ...props }) {
  return <input type={type} className={cn(className)} {...props} />;
}
