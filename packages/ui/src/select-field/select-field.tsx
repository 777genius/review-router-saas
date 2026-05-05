"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { cn } from "../utils/cn";

export type SelectFieldOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
};

export type SelectFieldProps = {
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
  readonly options: readonly SelectFieldOption[];
  readonly disabled?: boolean;
  readonly className?: string;
};

export function SelectField({
  name,
  label,
  defaultValue,
  options,
  disabled,
  className,
}: SelectFieldProps): React.ReactElement {
  return (
    <label className={cn("grid min-w-0 gap-2 text-sm text-slate-300", className)}>
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </span>
      <BaseSelect.Root
        name={name}
        defaultValue={defaultValue}
        disabled={disabled}
        items={options.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      >
        <BaseSelect.Trigger
          className={cn(
            "flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-cyan-200/15 bg-slate-950/80 px-3 py-2 text-left text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-cyan-200/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <BaseSelect.Value className="min-w-0 truncate" />
          <BaseSelect.Icon className="shrink-0 text-cyan-100">⌄</BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner
            sideOffset={8}
            alignItemWithTrigger={false}
            className="z-50"
          >
            <BaseSelect.Popup
              className="max-h-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-cyan-200/15 bg-[#080b12] p-1.5 text-cyan-50 shadow-[0_24px_80px_rgba(0,0,0,0.72),0_0_60px_-32px_rgba(0,240,255,0.9)] outline-none"
              style={{
                minWidth:
                  "min(max(var(--anchor-width), 18rem), calc(100vw - 2rem))",
              }}
            >
              <BaseSelect.List>
                {options.map((option) => (
                  <BaseSelect.Item
                    key={option.value}
                    value={option.value}
                    label={option.label}
                    className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-3.5 py-3 text-sm leading-5 text-slate-200 outline-none transition data-[highlighted]:bg-cyan-300/10 data-[highlighted]:text-cyan-50"
                  >
                    <BaseSelect.ItemIndicator className="flex h-5 w-5 shrink-0 items-center justify-center pt-0.5 text-lime-200">
                      ✓
                    </BaseSelect.ItemIndicator>
                    <BaseSelect.ItemText className="min-w-0 flex-1">
                      <span className="block whitespace-normal font-medium">
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="mt-1 block whitespace-normal text-xs leading-5 text-slate-400">
                          {option.description}
                        </span>
                      ) : null}
                    </BaseSelect.ItemText>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </label>
  );
}
