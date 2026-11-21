import PlusIcon from "lucide-react/dist/esm/icons/plus";
import type { ComponentProps } from "react";
import { Button } from "@/ui/button";

type AddRowButtonProps = Omit<
  ComponentProps<typeof Button>,
  "className" | "size" | "type" | "variant"
>;

/** The "Adicionar" row that closes a list of child items: a large control, dashed outline, the whole width of the list. */
export function AddRowButton({ children, ...props }: AddRowButtonProps) {
  return (
    <Button
      {...props}
      className="h-auto min-h-ctl-lg w-full whitespace-normal border-input border-dashed bg-transparent py-1 shadow-none hover:bg-accent dark:bg-transparent"
      size="lg"
      type="button"
      variant="outline"
    >
      <PlusIcon aria-hidden="true" data-icon="inline-start" />
      {children}
    </Button>
  );
}
