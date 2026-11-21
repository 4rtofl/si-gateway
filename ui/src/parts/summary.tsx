import type { UsageSummaryJson } from "@api/types.ts";
import type { ReactNode } from "react";
import { formatTokens, formatUsd } from "@/app/format";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

type Row = UsageSummaryJson & { id: string; name: string; link?: ReactNode };

/** 利用者・sigw キー・モデルごとの集計の表 */
export function SummaryTable({ rows, label }: { rows: Row[]; label: string }) {
	const columns: DataTableColumn<Row>[] = [
		{
			key: "name",
			header: label,
			cell: (row) => row.link ?? row.name,
			primary: true,
			width: "minmax(0, 2fr)",
		},
		{
			key: "requests",
			header: "呼び出し",
			align: "right",
			cell: (row) => (
				<span className="tabular-nums">
					{row.requests}
					{row.errors > 0 && (
						<span className="ml-1 text-xs text-[var(--text-muted)]">
							(エラー {row.errors})
						</span>
					)}
				</span>
			),
			width: "120px",
		},
		{
			key: "inputTokens",
			header: "入力",
			align: "right",
			cell: (row) => formatTokens(row.inputTokens),
			width: "90px",
			hideOnMobile: true,
		},
		{
			key: "cacheReadTokens",
			header: "キャッシュ読み",
			align: "right",
			cell: (row) => formatTokens(row.cacheReadTokens),
			width: "110px",
			hideOnMobile: true,
		},
		{
			key: "cacheWriteTokens",
			header: "キャッシュ書き",
			align: "right",
			cell: (row) => formatTokens(row.cacheWriteTokens),
			width: "110px",
			hideOnMobile: true,
		},
		{
			key: "outputTokens",
			header: "出力",
			align: "right",
			cell: (row) => formatTokens(row.outputTokens),
			width: "90px",
			hideOnMobile: true,
		},
		{
			key: "costNano",
			header: "料金",
			align: "right",
			cell: (row) => (
				<span className="inline-flex items-center gap-2 tabular-nums">
					{formatUsd(row.costNano)}
					{row.unpriced > 0 && (
						<Badge tone="warning">不明 {row.unpriced}</Badge>
					)}
				</span>
			),
			width: "150px",
		},
	];
	return (
		<DataTable
			rows={rows}
			columns={columns}
			selectable={false}
			searchable={rows.length > 10}
			searchPlaceholder={`${label}で絞り込む`}
			defaultSort={{ key: "costNano", dir: "desc" }}
			density="compact"
			ariaLabel={`${label}ごとの使用量`}
			emptyState={
				<p className="py-8 text-center text-sm text-[var(--text-muted)]">
					この月の呼び出しはありません。
				</p>
			}
		/>
	);
}
