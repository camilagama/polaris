import type * as React from "react";
import { InputGroup, InputGroupInput } from "@/ui/input-group";

/* Polaris v5.1: every text field is a group (border, focus, error and the 48 px touch area live on the group).
   `className` goes to the group (width, margin), the other props to the <input>. 36 px with touch, 32 with a mouse.
   A field with text beside the control (the "R$" of a price) is an InputGroup with an InputGroupAddon. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputGroup className={className}>
      <InputGroupInput type={type} {...props} />
    </InputGroup>
  );
}

export { Input };
