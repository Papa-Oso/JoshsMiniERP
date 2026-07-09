import type { ReactNode } from "react";

type Tone = "ok" | "warn" | "danger";

export function PanelFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className ?? ""}`}>{children}</section>;
}

export function PanelHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <header className="panel-header">
      <span>{icon}</span>
      <h2>{title}</h2>
    </header>
  );
}

export function Panel({
  title,
  icon,
  children,
  className
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <PanelFrame className={className}>
      <PanelHeader icon={icon} title={title} />
      {children}
    </PanelFrame>
  );
}

export function Metric({ label, value, tone }: { label: string; value: number | string; tone?: Tone }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function MiniStat({ label, value, tone }: { label: string; value: number | string; tone?: Tone }) {
  return (
    <div className={`mini-stat ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
