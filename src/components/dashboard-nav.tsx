"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/repositories", label: "Repositories" },
] as const;

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Dashboard" className="flex gap-1">
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm ${
              active ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
