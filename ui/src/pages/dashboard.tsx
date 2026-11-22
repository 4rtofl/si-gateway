import type {
	SigwKeyJson,
	UsageEventJson,
	UsageOverviewJson,
} from "@api/types.ts";
import { Link } from "react-router";
import { formatUsd, monthLabel, shiftMonth } from "@/app/format";
import { useMe } from "@/app/me";
import { useData } from "@/app/use-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { EventsTable } from "@/parts/events";
import { PageHeader, Section } from "@/parts/layout";
import { UsageMatrix } from "@/parts/matrix";
import { LimitBar } from "@/parts/usage";

type Daily = UsageOverviewJson["daily"];

/** 1日から各日までの累計(nano USD)。filter に合う行だけを足す */
function cumulative(
	daily: Daily,
	days: number,
	filter: (row: Daily[number]) => boolean,
): number[] {
	const perDay = new Array<number>(days).fill(0);
	for (const row of daily) {
		if (row.day >= 1 && row.day <= days && filter(row))
			perDay[row.day - 1] = (perDay[row.day - 1] ?? 0) + row.costNano;
	}
	let sum = 0;
	return perDay.map((value) => (sum += value));
}

export function DashboardPage() {
	const { me } = useMe();
	const month = me.month;
	const previousMonth = shiftMonth(month, -1);
	const current = useData<UsageOverviewJson>(`/usage?month=${month}`);
	const previous = useData<UsageOverviewJson>(`/usage?month=${previousMonth}`);
	const keys = useData<SigwKeyJson[]>("/sigw-keys");
	const events = useData<UsageEventJson[]>(
		`/usage/events?month=${month}&limit=15`,
	);

	if (!current.data || !previous.data || !keys.data || !events.data) {
		return (
			<>
				<PageHeader title={`${monthLabel(month)}の使用量`} />
				{current.error ? (
					<Alert tone="danger">
						<AlertDescription>{current.error}</AlertDescription>
					</Alert>
				) : (
					<Skeleton className="h-64 w-full" />
				)}
			</>
		);
	}

	const currentDaily = current.data.daily;
	const previousDaily = previous.data.daily;
	const today = Math.max(
		...currentDaily.map((row) => row.day),
		new Date().getDate(),
	);
	const myId = me.user.id;
	const stats: {
		label: string;
		filter: (row: Daily[number]) => boolean;
		goodWhen: "up" | "down";
	}[] = [
		{ label: "Org 全体", filter: () => true, goodWhen: "down" },
		{
			label: "自分が使った額",
			filter: (row) => row.userId === myId,
			goodWhen: "down",
		},
		{
			label: "他の人のキーで使った額",
			filter: (row) => row.userId === myId && row.ownerId !== myId,
			goodWhen: "down",
		},
		{
			label: "自分のキーが使われた額",
			filter: (row) => row.ownerId === myId && row.userId !== myId,
			goodWhen: "up",
		},
	];
	const unpriced = current.data.pairs.reduce(
		(sum, row) => sum + row.unpriced,
		0,
	);
	const spend = new Map(
		current.data.byKey.map((row) => [row.sigwKeyId, row.costNano]),
	);
	const activeKeys = keys.data.filter(
		(key) =>
			key.revokedAt === null &&
			key.providerKeys.some((providerKey) => !providerKey.disabled),
	);

	return (
		<>
			<PageHeader
				title={`${monthLabel(month)}の使用量`}
				actions={
					<Link
						to={`/usage?month=${month}`}
						className="text-sm text-[var(--text-secondary)] hover:underline"
					>
						内訳
					</Link>
				}
			/>
			{unpriced > 0 && (
				<Alert tone="warning" className="mb-6">
					<AlertDescription>
						料金が不明な呼び出しが {unpriced} 件あります。
						<Link to="/prices" className="underline">
							価格
						</Link>
						でモデルの単価を足すと、料金を計算し直します。
					</AlertDescription>
				</Alert>
			)}
			<StatGrid className="mb-6">
				{stats.map((stat) => {
					const trend = cumulative(currentDaily, today, stat.filter);
					const last = cumulative(previousDaily, today, stat.filter);
					return (
						<StatCard
							key={stat.label}
							label={stat.label}
							value={trend[trend.length - 1] ?? 0}
							trend={trend}
							trendLabels={trend.map(
								(_, index) => `${Number(month.slice(5))}月${index + 1}日まで`,
							)}
							previous={last[last.length - 1] ?? 0}
							goodWhen={stat.goodWhen}
							period={
								(last[last.length - 1] ?? 0) > 0
									? "先月の同じ日まで比"
									: "先月の同じ日までは $0"
							}
							format={formatUsd}
						/>
					);
				})}
			</StatGrid>
			<Section title="利用者とキーの所有者">
				<UsageMatrix pairs={current.data.pairs} />
			</Section>
			<Section
				title="sigw キーの今月の使用額"
				actions={
					<Link
						to="/keys"
						className="text-sm text-[var(--text-secondary)] hover:underline"
					>
						キーの管理
					</Link>
				}
			>
				{activeKeys.length === 0 ? (
					<p className="text-sm text-[var(--text-muted)]">
						有効な sigw キーはありません。
						<Link to="/keys" className="underline">
							キー
						</Link>
						から発行できます。
					</p>
				) : (
					<ul className="divide-y divide-[var(--border)]">
						{activeKeys.map((key: SigwKeyJson) => (
							<li
								key={key.id}
								className="flex flex-wrap items-center justify-between gap-3 py-2.5"
							>
								<Link
									to={`/keys/${key.id}`}
									className="min-w-0 truncate text-sm hover:underline"
								>
									{key.purpose}
								</Link>
								<LimitBar
									spent={spend.get(key.id) ?? 0}
									limit={key.monthlyLimitNano}
								/>
							</li>
						))}
					</ul>
				)}
			</Section>
			<Section
				title="最近の呼び出し"
				actions={
					<Link
						to={`/usage?month=${month}`}
						className="text-sm text-[var(--text-secondary)] hover:underline"
					>
						すべて
					</Link>
				}
			>
				<EventsTable events={events.data} keys={keys.data} pageSize={15} />
			</Section>
		</>
	);
}
