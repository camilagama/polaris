import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { type ChangeEvent, useCallback } from "react";
import { groupCategories } from "./expense-model";

interface ExpenseCategorySelectProps {
  categories: readonly ExpenseCategoryReadModel[];
  describedBy?: string | undefined;
  disabled: boolean;
  id: string;
  invalid?: boolean | undefined;
  onChange: (categoryId: string) => void;
  /** Text of the option that stands for no category. */
  placeholder: string;
  value: string;
}

/** Categories as options, under the label of their group. */
export function ExpenseCategorySelect({
  categories,
  describedBy,
  disabled,
  id,
  invalid,
  onChange,
  placeholder,
  value,
}: ExpenseCategorySelectProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onChange(event.currentTarget.value),
    [onChange]
  );

  return (
    <select
      aria-describedby={describedBy}
      aria-invalid={invalid ? true : undefined}
      className="expense-select"
      disabled={disabled}
      id={id}
      onChange={handleChange}
      value={value}
    >
      <option value="">{placeholder}</option>
      {groupCategories(categories).map((section) => (
        <optgroup key={section.key} label={section.label}>
          {section.items.map((category) => (
            <option key={category.id} value={category.id}>
              {category.status === "archived"
                ? `${category.name} (arquivada)`
                : category.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
