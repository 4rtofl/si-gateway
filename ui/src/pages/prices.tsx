import type { PriceRowJson } from "@api/types.ts";
import { type FormEvent, useState } from "react";
import { api } from "@/app/api";
import { formatDate } from "@/app/format";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { useData } from "@/app/use-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Form, Input, Select } from "@/components/ui/form";
import {
	Sheet,
	SheetBody,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Field } from "@/parts/field";
import { PageHeader, Section } from "@/parts/layout";

type Row = PriceRowJson & { id: string };

/** USD / トークン を「100万トークンあたりの USD」で表示する */
function perM(value: number | undefined): string {
	if (value === undefined) return "—";
	const perMillion = value * 1e6;
	return `$${perMillion >= 1 ? perMillion.toFixed(2) : perMillion.toFixed(4)}`;
}

function PriceSheet({
	open,
	onOpenChange,
	initial,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initial: Row | null;
	onSaved: () => void;
}) {
	const { me } = useMe();
	const toast = useToast();
	const [provider, setProvider] = useState<string>(
		initial?.provider ?? me.providers[0]?.id ?? "openai",
	);
	const [model, setModel] = useState(initial?.model ?? "");
	const value = (price: number | undefined) =>
		price === undefined ? "" : String(+(price * 1e6).toFixed(6));
	const [input, setInput] = useState(value(initial?.price.input));
	const [output, setOutput] = useState(value(initial?.price.output));
	const [cacheRead, setCacheRead] = useState(value(initial?.price.cacheRead));
	const [cacheWrite, setCacheWrite] = useState(
		value(initial?.price.cacheWrite),
	);
	const [busy, setBusy] = useState(false);
	const optional = (text: string) => (text.trim() === "" ? null : Number(text));

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const result = await api<{ repriced: number }>("/prices", {
				method: "PUT",
				body: {
					provider,
					model,
					inputPerM: Number(input),
					outputPerM: Number(output),
					cacheReadPerM: optional(cacheRead),
					cacheWritePerM: optional(cacheWrite),
				},
			});
			toast(
				result.repriced > 0
					? `保存し、${result.repriced} 件の料金を計算し直しました`
					: "保存しました",
			);
			onOpenChange(false);
			onSaved();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>単価を決める</SheetTitle>
				</SheetHeader>
				<SheetBody>
					<Form onSubmit={submit}>
						<Field label="プロバイダ">
							{(id) => (
								<Select
									id={id}
									value={provider}
									onChange={(event) => setProvider(event.target.value)}
									options={me.providers.map((item) => ({
										value: item.id,
										label: item.label,
									}))}
								/>
							)}
						</Field>
						<Field label="モデル" hint="応答の model と同じ名前。">
							{(id) => (
								<Input
									id={id}
									value={model}
									onChange={(event) => setModel(event.target.value)}
									required
								/>
							)}
						</Field>
						<p className="text-xs text-[var(--text-muted)]">
							単価は100万トークンあたりの USD です。
						</p>
						<div className="grid grid-cols-2 gap-3">
							<Field label="入力">
								{(id) => (
									<Input
										id={id}
										type="number"
										step="any"
										min="0"
										value={input}
										onChange={(e) => setInput(e.target.value)}
										required
									/>
								)}
							</Field>
							<Field label="出力">
								{(id) => (
									<Input
										id={id}
										type="number"
										step="any"
										min="0"
										value={output}
										onChange={(e) => setOutput(e.target.value)}
										required
									/>
								)}
							</Field>
							<Field label="キャッシュ読み">
								{(id) => (
									<Input
										id={id}
										type="number"
										step="any"
										min="0"
										value={cacheRead}
										onChange={(e) => setCacheRead(e.target.value)}
									/>
								)}
							</Field>
							<Field label="キャッシュ書き">
								{(id) => (
									<Input
										id={id}
										type="number"
										step="any"
										min="0"
										value={cacheWrite}
										onChange={(e) => setCacheWrite(e.target.value)}
									/>
								)}
							</Field>
						</div>
						<Button type="submit" isLoading={busy} fullWidth>
							保存
						</Button>
					</Form>
				</SheetBody>
			</SheetContent>
		</Sheet>
	);
}

export function PricesPage() {
	const { me } = useMe();
	const toast = useToast();
	const [provider, setProvider] = useState("");
	const [query, setQuery] = useState("");
	const [applied, setApplied] = useState({ provider: "", query: "" });
	const prices = useData<PriceRowJson[]>(
		`/prices?limit=500&provider=${encodeURIComponent(applied.provider)}&q=${encodeURIComponent(applied.query)}`,
	);
	const [editing, setEditing] = useState<Row | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [syncing, setSyncing] = useState(false);

	const sync = async () => {
		setSyncing(true);
		try {
			const result = await api<{ synced: number; repriced: number }>(
				"/prices/sync",
				{ method: "POST" },
			);
			toast(`LiteLLM の価格表から ${result.synced} 件を取り込みました`);
			await prices.reload();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		} finally {
			setSyncing(false);
		}
	};

	const removeManual = async (row: Row) => {
		if (
			!window.confirm(
				`${row.model} の手で決めた単価を消しますか？次の同期で LiteLLM の単価に戻ります。`,
			)
		)
			return;
		try {
			await api(
				`/prices?provider=${encodeURIComponent(row.provider)}&model=${encodeURIComponent(row.model)}`,
				{
					method: "DELETE",
				},
			);
			toast("消しました");
			await prices.reload();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const rows: Row[] = (prices.data ?? []).map((row) => ({
		...row,
		id: `${row.provider}:${row.model}`,
	}));
	const columns: DataTableColumn<Row>[] = [
		{
			key: "model",
			header: "モデル",
			cell: (row) => <span className="font-mono text-xs">{row.model}</span>,
			primary: true,
			width: "minmax(0, 2.4fr)",
		},
		{
			key: "provider",
			header: "プロバイダ",
			accessor: (row) =>
				me.providers.find((item) => item.id === row.provider)?.label ??
				row.provider,
			width: "110px",
		},
		{
			key: "input",
			header: "入力",
			align: "right",
			accessor: (row) => row.price.input,
			cell: (row) => perM(row.price.input),
			width: "90px",
		},
		{
			key: "output",
			header: "出力",
			align: "right",
			accessor: (row) => row.price.output,
			cell: (row) => perM(row.price.output),
			width: "90px",
		},
		{
			key: "cacheRead",
			header: "キャッシュ読み",
			align: "right",
			accessor: (row) => row.price.cacheRead ?? -1,
			cell: (row) => perM(row.price.cacheRead),
			width: "110px",
			hideOnMobile: true,
		},
		{
			key: "source",
			header: "出所",
			cell: (row) =>
				row.source === "manual" ? (
					<Badge tone="warning">手で指定</Badge>
				) : (
					<Badge>LiteLLM</Badge>
				),
			width: "100px",
		},
		{
			key: "updatedAt",
			header: "更新",
			accessor: (row) => row.updatedAt,
			cell: (row) => formatDate(row.updatedAt),
			width: "100px",
			hideOnMobile: true,
		},
		{
			key: "actions",
			header: "",
			sortable: false,
			align: "right",
			cell: (row) => (
				<span className="inline-flex gap-1">
					<Button
						variant="ghost"
						size="sm"
						onClick={(event) => {
							event.stopPropagation();
							setEditing(row);
							setSheetOpen(true);
						}}
					>
						変更
					</Button>
					{row.source === "manual" && (
						<Button
							variant="ghost"
							size="sm"
							onClick={(event) => {
								event.stopPropagation();
								void removeManual(row);
							}}
						>
							消す
						</Button>
					)}
				</span>
			),
			width: "140px",
		},
	];

	return (
		<>
			<PageHeader
				title="価格"
				actions={
					<>
						<Button
							variant="secondary"
							size="sm"
							isLoading={syncing}
							onClick={sync}
						>
							LiteLLM から同期
						</Button>
						<Button
							size="sm"
							onClick={() => {
								setEditing(null);
								setSheetOpen(true);
							}}
						>
							単価を決める
						</Button>
					</>
				}
			/>
			<Section>
				<Form
					onSubmit={(event) => {
						event.preventDefault();
						setApplied({ provider, query });
					}}
					className="mb-4 grid gap-3 space-y-0 sm:grid-cols-[180px_1fr_auto] sm:items-end"
				>
					<Field label="プロバイダ">
						{(id) => (
							<Select
								id={id}
								value={provider}
								onChange={(event) => setProvider(event.target.value)}
								options={[
									{ value: "", label: "すべて" },
									...me.providers.map((item) => ({
										value: item.id,
										label: item.label,
									})),
								]}
							/>
						)}
					</Field>
					<Field label="モデル名">
						{(id) => (
							<Input
								id={id}
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="claude-sonnet"
							/>
						)}
					</Field>
					<Button type="submit" variant="secondary">
						探す
					</Button>
				</Form>
				{prices.data ? (
					<DataTable
						rows={rows}
						columns={columns}
						selectable={false}
						searchable={false}
						pageSize={50}
						density="compact"
						ariaLabel="モデルの単価"
						emptyState={
							<p className="py-8 text-center text-sm text-[var(--text-muted)]">
								単価がありません。「LiteLLM から同期」で取り込めます。
							</p>
						}
					/>
				) : (
					<Skeleton className="h-64 w-full" />
				)}
			</Section>
			{sheetOpen && (
				<PriceSheet
					key={editing?.id ?? "new"}
					open={sheetOpen}
					onOpenChange={setSheetOpen}
					initial={editing}
					onSaved={() => void prices.reload()}
				/>
			)}
		</>
	);
}
