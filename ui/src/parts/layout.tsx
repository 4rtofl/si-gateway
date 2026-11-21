import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
	title,
	actions,
}: {
	title: string;
	actions?: ReactNode;
}) {
	return (
		<div className="mb-6 flex flex-wrap items-center justify-between gap-3">
			<h1 className="text-xl font-semibold">{title}</h1>
			{actions && (
				<div className="flex flex-wrap items-center gap-2">{actions}</div>
			)}
		</div>
	);
}

export function Section({
	title,
	actions,
	children,
	className,
}: {
	title?: string;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5",
				className,
			)}
		>
			{(title || actions) && (
				<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
					{title && <h2 className="text-sm font-semibold">{title}</h2>}
					{actions}
				</div>
			)}
			{children}
		</section>
	);
}

export function Muted({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<p className={cn("text-sm text-[var(--text-secondary)]", className)}>
			{children}
		</p>
	);
}

export function Mono({ children }: { children: ReactNode }) {
	return <span className="font-mono text-xs">{children}</span>;
}
