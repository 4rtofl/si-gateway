import type { SigwKeyJson, UsageEventJson } from "@api/types.ts";
import { Link } from "react-router";
import { formatDateTime, formatTokens } from "@/app/format";
import { useMe } from "@/app/me";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { CostCell, StatusBadge } from "./usage.tsx";

/** 呼び出しの一覧 */
export function EventsTable({
	events,
	keys,
	pageSize = 20,
}: {
	events: UsageEventJson[];
	keys: SigwKeyJson[];
	pageSize?: number;
}) {
	const { nameOf } = useMe();
	const purposes = new Map(keys.map((key) => [key.id, key.purpose]));
	const columns: DataTableColumn<UsageEventJson>[] = [
		{
			key: "createdAt",
			header: "日時",
			accessor: (row) => row.createdAt,
			cell: (row) => (
				<span className="tabular-nums">{formatDateTime(row.createdAt)}</span>
			),
			primary: true,
			width: "140px",
		},
		{
			key: "userId",
			header: "利用者",
			accessor: (row) => nameOf(row.userId),
			// Bobert からの代理の呼び出しには印を付ける
			cell: (row) => (
				<span className="flex items-center gap-1.5">
					{nameOf(row.userId)}
					{row.via === "bobert" && (
						<Badge title="Bobert からの代理の呼び出し">Bobert</Badge>
					)}
				</span>
			),
			width: "1fr",
		},
		{
			key: "sigwKeyId",
			header: "目的",
			accessor: (row) => purposes.get(row.sigwKeyId) ?? row.sigwKeyId,
			cell: (row) => (
				<Link to={`/keys/${row.sigwKeyId}`} className="hover:underline">
					{purposes.get(row.sigwKeyId) ?? row.sigwKeyId}
				</Link>
			),
			width: "1.2fr",
		},
		{
			key: "model",
			header: "モデル",
			accessor: (row) => row.model ?? row.path,
			cell: (row) => (
				<span className="font-mono text-xs">{row.model ?? row.path}</span>
			),
			width: "1.6fr",
		},
		{
			key: "status",
			header: "状態",
			cell: (row) => <StatusBadge event={row} />,
			width: "110px",
		},
		{
			key: "inputTokens",
			header: "入力",
			align: "right",
			cell: (row) => formatTokens(row.inputTokens),
			width: "80px",
			hideOnMobile: true,
		},
		{
			key: "cacheReadTokens",
			header: "キャッシュ",
			align: "right",
			accessor: (row) => row.cacheReadTokens + row.cacheWriteTokens,
			cell: (row) => formatTokens(row.cacheReadTokens + row.cacheWriteTokens),
			width: "90px",
			hideOnMobile: true,
		},
		{
			key: "outputTokens",
			header: "出力",
			align: "right",
			cell: (row) => formatTokens(row.outputTokens),
			width: "80px",
			hideOnMobile: true,
		},
		{
			key: "costNano",
			header: "料金",
			align: "right",
			accessor: (row) => row.costNano ?? -1,
			cell: (row) => <CostCell nano={row.costNano} source={row.costSource} />,
			width: "100px",
		},
		{
			key: "ttfbMs",
			header: "TTFB",
			align: "right",
			accessor: (row) => row.ttfbMs ?? -1,
			cell: (row) => (row.ttfbMs === null ? "—" : `${row.ttfbMs}ms`),
			width: "80px",
			hideOnMobile: true,
		},
	];
	return (
		<DataTable
			rows={events}
			columns={columns}
			selectable={false}
			searchable={events.length > 10}
			searchPlaceholder="利用者・目的・モデルで絞り込む"
			pageSize={pageSize}
			density="compact"
			defaultSort={{ key: "createdAt", dir: "desc" }}
			ariaLabel="呼び出しの一覧"
			emptyState={
				<p className="py-8 text-center text-sm text-[var(--text-muted)]">
					呼び出しはまだありません。
				</p>
			}
		/>
	);
}
