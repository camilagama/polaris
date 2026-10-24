import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import {
  categoryNameCountLabel,
  categoryNameIsTooLong,
} from "./categories-model";

interface CategoryFormProps {
  isPending: boolean;
  name: string;
  onNameChange: (value: string) => void;
  online: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

const NAME_REQUIRED = "Informe o nome da categoria.";

/** A new category: one field and its button on one line (they stack below 480 px). */
export function CategoryForm({
  isPending,
  name,
  onNameChange,
  online,
  onSubmit,
}: CategoryFormProps) {
  const [showRequired, setShowRequired] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tooLong = categoryNameIsTooLong(name);
  const error = tooLong
    ? categoryNameCountLabel(name)
    : (showRequired && name.trim() === "" && NAME_REQUIRED) || undefined;

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setShowRequired(false);
      onNameChange(event.target.value);
    },
    [onNameChange]
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (name.trim() === "") {
        event.preventDefault();
        setShowRequired(true);
        inputRef.current?.focus();
        return;
      }
      onSubmit(event);
    },
    [name, onSubmit]
  );
  return (
    <Card>
      <CardContent>
        <form noValidate onSubmit={handleSubmit}>
          <Field className="min-w-0" data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="category-name">Nova categoria</FieldLabel>
            <div className="flex flex-col gap-3 min-[30rem]:flex-row">
              <InputGroup className="min-[30rem]:flex-1">
                <InputGroupInput
                  aria-describedby="category-name-text"
                  aria-invalid={error ? true : undefined}
                  autoComplete="off"
                  id="category-name"
                  onChange={handleChange}
                  placeholder="Ex.: Acessórios"
                  ref={inputRef}
                  value={name}
                />
              </InputGroup>
              <Button
                {...connectionControlProps(online)}
                disabled={isPending || tooLong}
                type="submit"
              >
                {isPending ? "Salvando…" : "Adicionar categoria"}
              </Button>
            </div>
            {error ? (
              <FieldError id="category-name-text">{error}</FieldError>
            ) : (
              <FieldDescription id="category-name-text">
                {categoryNameCountLabel(name)}
              </FieldDescription>
            )}
          </Field>
        </form>
      </CardContent>
    </Card>
  );
}
