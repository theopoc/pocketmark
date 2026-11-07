import { cn } from "../../lib/utils";

export function Textarea({ className, ...props }) {
  return <textarea className={cn(className)} {...props} />;
}
