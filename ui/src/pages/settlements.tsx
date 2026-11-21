import type { SettlementJson, SettlementPreviewJson } from "@api/types.ts";
import { type FormEvent, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "@/app/api";
import {
	formatDateTime,
	formatUsd,
	formatYen,
	monthLabel,
	shiftMonth,
} from "@/app/format";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { useData } from "@/app/use-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Form, Input } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Field } from "@/parts/field";
import { PageHeader, Section } from "@/parts/layout";
import { MonthNav } from "@/parts/month-nav";

function Lines({ detail }: { detail: SettlementPreviewJson["detail"] }) {
	if (detail.lines.length === 0) {
		return (
			<p className="text-sm text-[var(--text-muted)]">支払いはありません。</p>
		);
	}
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left text-xs text-[var(--text-muted)]">
						<th className="py-2 pr-4 font-medium">支払う人</th>
						<th className="px-4 py-2 font-medium">受け取る人</th>
						<th className="px-4 py-2 text-right font-medium">USD</th>
						<th className="py-2 pl-4 text-right font-medium">円</th>
					</tr>
				</thead>
				<tbody>
					{detail.lines.map((line) => (
						<tr key={line.id} className="border-t border-[var(--border)]">
							<td className="py-2.5 pr-4">{line.debtorName}</td>
							<td className="px-4 py-2.5">{line.payerName}</td>
							<td className="px-4 py-2.5 text-right tabular-nums">
								{formatUsd(line.costNano)}
							</td>
							<td className="py-2.5 pl-4 text-right font-medium tabular-nums">
								{formatYen(line.yen)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function FxForm({
	month,
	current,
	onSaved,
}: {
	month: string;
	current: SettlementPreviewJson;
	onSaved: () => void;
}) {
	const toast = useToast();
	const [rate, setRate] = useState(
		current.fxSource === "manual" ? String(current.usdJpy) : "",
	);
	const save = async (usdJpy: number | null) => {
		try {
			await api(`/settlements/${month}/fx`, {
				method: "PUT",
				body: { usdJpy },
			});
			toast(
				usdJpy === null
					? "自動で取得したレートに戻しました"
					: "為替レートを保存しました",
			);
			if (usdJpy === null) setRate("");
			onSaved();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void save(Number(rate));
	};
	return (
		<Form onSubmit={submit} className="max-w-sm">
			<Field
				label="1 USD あたりの円"
				hint="空のままなら、精算のときに自動で取得します。"
			>
				{(id) => (
					<Input
						id={id}
						type="number"
						step="0.01"
						min="50"
						inputMode="decimal"
						value={rate}
						onChange={(event) => setRate(event.target.value)}
						placeholder={current.usdJpy.toFixed(2)}
					/>
				)}
			</Field>
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={rate.trim() === ""}>
					保存
				</Button>
				{current.fxSource === "manual" && (
					<Button variant="ghost" size="sm" onClick={() => void save(null)}>
						自動に戻す
					</Button>
				)}
			</div>
		</Form>
	);
}

export function SettlementsPage() {
	const { me, nameOf } = useMe();
	const toast = useToast();
	const [params, setParams] = useSearchParams();
	const month = params.get("month") ?? shiftMonth(me.month, -1);
	const preview = useData<SettlementPreviewJson>(`/settlements/${month}`);
	const history = useData<SettlementJson[]>("/settlements");
	const [running, setRunning] = useState(false);

	const run = async () => {
		if (
			!window.confirm(
				`${monthLabel(month)}を精算し、Daichoo の台帳に書き込みますか？`,
			)
		)
			return;
		setRunning(true);
		try {
			await api(`/settlements/${month}`, { method: "POST" });
			toast("精算して、台帳に書き込みました");
			await Promise.all([preview.reload(), history.reload()]);
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		} finally {
			setRunning(false);
		}
	};

	const data = preview.data;
	return (
		<>
			<PageHeader
				title="精算"
				actions={
					<MonthNav
						month={month}
						max={me.month}
						onChange={(next) => setParams({ month: next })}
					/>
				}
			/>
			{preview.error && (
				<Alert tone="danger" className="mb-6">
					<AlertDescription>{preview.error}</AlertDescription>
				</Alert>
			)}
			{!data ? (
				!preview.error && <Skeleton className="h-48 w-full" />
			) : (
				<>
					<Section
						title={monthLabel(month)}
						actions={
							data.settled ? (
								<Badge tone="success">精算済み</Badge>
							) : data.settleable ? (
								<Button size="sm" isLoading={running} onClick={run}>
									精算して台帳に書く
								</Button>
							) : (
								<Badge>月の途中</Badge>
							)
						}
					>
						<p className="mb-4 text-sm text-[var(--text-secondary)]">
							1 USD = {data.usdJpy.toFixed(2)}円(
							{data.fxSource === "manual" ? "手で指定" : data.fxSource})
						</p>
						{data.detail.unpriced > 0 && (
							<Alert tone="warning" className="mb-4">
								<AlertDescription>
									料金が不明な呼び出しが {data.detail.unpriced}{" "}
									件あり、精算に入っていません。
								</AlertDescription>
							</Alert>
						)}
						<Lines detail={data.detail} />
						{data.detail.selfUseNano > 0 && (
							<p className="mt-4 text-xs text-[var(--text-muted)]">
								自分のキーを自分で使った {formatUsd(data.detail.selfUseNano)}{" "}
								は請求しません。
							</p>
						)}
						{data.settled && (
							<p className="mt-4 text-xs text-[var(--text-muted)]">
								{formatDateTime(data.settled.settledAt)}に
								{data.settled.settledBy === "cron"
									? "自動で"
									: `${nameOf(data.settled.settledBy)}が`}
								精算しました。
								{data.settled.ledgerUrl && (
									<>
										{" "}
										<a
											href={data.settled.ledgerUrl}
											target="_blank"
											rel="noreferrer"
											className="underline"
										>
											台帳を開く
										</a>
									</>
								)}
							</p>
						)}
					</Section>
					{!data.settled && (
						<Section title="為替レート">
							<FxForm
								month={month}
								current={data}
								onSaved={() => void preview.reload()}
							/>
						</Section>
					)}
				</>
			)}
			<Section title="精算した月">
				{!history.data ? (
					<Skeleton className="h-20 w-full" />
				) : history.data.length === 0 ? (
					<p className="text-sm text-[var(--text-muted)]">
						まだ精算していません。毎月1日の0時5分に、前の月を自動で精算します。
					</p>
				) : (
					<ul className="divide-y divide-[var(--border)]">
						{history.data.map((item) => (
							<li
								key={item.month}
								className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm"
							>
								<button
									type="button"
									className="hover:underline"
									onClick={() => setParams({ month: item.month })}
								>
									{monthLabel(item.month)}
								</button>
								<span className="tabular-nums text-[var(--text-secondary)]">
									{formatYen(
										item.detail.lines.reduce((sum, line) => sum + line.yen, 0),
									)}
								</span>
							</li>
						))}
					</ul>
				)}
			</Section>
		</>
	);
}
