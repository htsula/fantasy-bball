"use client";

import { useRouter } from "next/navigation";
import { NativeSelect } from "@/components/ui/native-select";

/** Phone-only "Sort by" select: navigates to the server-rendered URL for the chosen sort. */
export function SortSelect({ value, options }: { value: string; options: { key: string; label: string; href: string }[] }) {
  const router = useRouter();
  return (
    <NativeSelect
      className="sm:hidden"
      aria-label="Sort by"
      data-testid="sort-by"
      value={value}
      onChange={(e) => {
        const o = options.find((x) => x.key === e.target.value);
        if (o) router.push(o.href);
      }}
    >
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </NativeSelect>
  );
}
