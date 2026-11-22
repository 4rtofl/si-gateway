import type {
	SigwKeyJson,
	UsageEventJson,
	UsageOverviewJson,
} from "@api/types.ts";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useMe } from "@/app/me";
import { useData } from "@/app/use-data";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { EventsTable, SigwKeyName, sigwKeyNames } from "@/parts/events";
import { PageHeader, Section } from "@/parts/layout";
import { UsageMatrix } from "@/parts/matrix";
import { MonthNav } from "@/parts/month-nav";
import { SummaryTable } from "@/parts/summary";

export function UsagePage() {
	const { me, nameOf } = useMe();
	const [params, setParams] = useSearchParams();
	const month = params.get("month") ?? me.month;
	const [tab, setTab] = useState("user");
	const overview = useData<UsageOverviewJson>(`/usage?month=${month}`);
	// 削除した sigw キーも、使用量に名前を出す
	const keys = useData<SigwKeyJson[]>("/sigw-keys?includeDeleted=1");
	const events = useData<UsageEventJson[]>(
		`/usage/events?month=${month}&limit=500`,
	);
	const purposes = sigwKeyNames(keys.data ?? []);

	const content = () => {
		if (!overview.data) return <Skeleton className="h-48 w-full" />;
		const data = overview.data;
		switch (tab) {
			case "pair":
				return <UsageMatrix pairs={data.pairs} />;
			case "key":
				return (
					<SummaryTable
						label="sigw キー"
						rows={data.byKey.map((row) => ({
							...row,
							id: row.sigwKeyId ?? "",
							name: purposes.get(row.sigwKeyId ?? "") ?? row.sigwKeyId ?? "",
							link: (
								<SigwKeyName
									id={row.sigwKeyId ?? ""}
									keys={keys.data ?? []}
									names={purposes}
								/>
							),
						}))}
					/>
				);
			case "model":
				return (
					<SummaryTable
						label="モデル"
						rows={data.byModel.map((row) => ({
							...row,
							id: `${row.provider}:${row.model}`,
							name: `${row.provider} / ${row.model ?? "(なし)"}`,
							link: (
								<span className="font-mono text-xs">{`${row.provider} / ${row.model ?? "(なし)"}`}</span>
							),
						}))}
					/>
				);
			default:
				return (
					<SummaryTable
						label="利用者"
						rows={data.byUser.map((row) => ({
							...row,
							id: row.userId ?? "",
							name: nameOf(row.userId),
						}))}
					/>
				);
		}
	};

	return (
		<>
			<PageHeader
				title="使用量"
				actions={
					<MonthNav
						month={month}
						max={me.month}
						onChange={(next) => setParams({ month: next })}
					/>
				}
			/>
			<Section>
				<AnimatedTabs
					tabs={[
						{ id: "user", label: "利用者" },
						{ id: "pair", label: "利用者とキーの所有者" },
						{ id: "key", label: "sigw キー" },
						{ id: "model", label: "モデル" },
					]}
					activeTab={tab}
					onChange={setTab}
					renderContent={false}
					variant="pill"
					className="mb-4"
				/>
				{content()}
			</Section>
			<Section title="呼び出し">
				{events.data && keys.data ? (
					<EventsTable events={events.data} keys={keys.data} pageSize={50} />
				) : (
					<Skeleton className="h-48 w-full" />
				)}
			</Section>
		</>
	);
}
