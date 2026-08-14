import type { ReactNode } from "react";

export function Note({ label = "Field note", children }: { label?: string; children: ReactNode }) {
  return (
    <aside className="article-note">
      <strong>{label}</strong>
      <div>{children}</div>
    </aside>
  );
}
