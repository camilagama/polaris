import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

/* Polaris v5.2: a 36 × 20 track (40 × 24 with touch), a 44 × 44 touch area through ::after, focus as a border and a
   30% halo, the checked track in --primary. The thumb never slides: it changes side and the track changes colour. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer relative inline-flex h-5 touch:h-6 touch:w-10 w-9 shrink-0 items-center rounded-full border border-input bg-input/60 p-px outline-none motion-full:transition-colors after:absolute after:-inset-3 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 aria-disabled:opacity-50 data-disabled:cursor-not-allowed data-checked:border-primary data-checked:bg-primary data-disabled:opacity-50 dark:bg-input/30 dark:data-checked:bg-primary",
        className
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="pointer-events-none block size-4 touch:size-5 rounded-full bg-foreground data-checked:translate-x-4 data-checked:bg-primary-foreground"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
