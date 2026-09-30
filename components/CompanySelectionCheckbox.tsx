"use client";
import {useEffect, useRef} from "react";

export default function CompanySelectionCheckbox({label, checked, mixed = false, disabled, onChange}: {
  label: string; checked: boolean; mixed?: boolean; disabled?: boolean; onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" aria-label={label} checked={checked} disabled={disabled}
    onClick={event => event.stopPropagation()} onChange={onChange}
    className="h-4 w-4 shrink-0 accent-ink disabled:cursor-not-allowed" />;
}
