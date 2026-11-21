import type { UsageEventJson } from "@api/types.ts";
import { formatUsd } from "@/app/format";
import { Badge } from "@/components/ui/badge";

export function LimitBar({
	spent,
	limit,
}: {
	spent: number;
	limit: number | null;
}) {
	if (limit === null) {
		return <span className="text-xs text-[var(--text-muted)]">上限なし</span>;
	}
	const ratio = Math.min(spent / limit, 1);
	const over = spent >= limit;
	return (
		<div className="flex min-w-40 items-center gap-2">
			<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-raised)]">
				<div
					className={
						over ? "h-full bg-rose-500" : "h-full bg-[var(--text-secondary)]"
					}
					style={{ width: `${(ratio * 100).toFixed(1)}%` }}
				/>
			</div>
			<span className="text-xs whitespace-nowrap tabular-nums">
				{formatUsd(spent)} / {formatUsd(limit)}
			</span>
		</div>
	);
}

export function StatusBadge({ event }: { event: UsageEventJson }) {
	if (event.status >= 400) {
		return (
			<Badge tone="danger" title={event.error ?? undefined}>
				{event.status}
			</Badge>
		);
	}
	if (event.incomplete) {
		return (
			<Badge tone="warning" title="使用量を最後まで受け取れませんでした">
				途中で切断
			</Badge>
		);
	}
	return <Badge tone="success">{event.status}</Badge>;
}

export function CostCell({
	nano,
	source,
}: {
	nano: number | null;
	source?: string | null;
}) {
	if (nano === null) {
		return <Badge tone="warning">料金不明</Badge>;
	}
	return (
		<span
			className="tabular-nums"
			title={source === "provider" ? "プロバイダが返した実費" : undefined}
		>
			{formatUsd(nano)}
		</span>
	);
}
