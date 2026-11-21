import type { UsageSummaryJson } from "@api/types.ts";
import { formatUsd } from "@/app/format";
import { useMe } from "@/app/me";

/** 利用者(行)× キーの所有者(列)の料金 */
export function UsageMatrix({ pairs }: { pairs: UsageSummaryJson[] }) {
	const { me, nameOf } = useMe();
	const ids = me.members.map((member) => member.id);
	const cell = (userId: string, ownerId: string) =>
		pairs.find((row) => row.userId === userId && row.ownerId === ownerId);
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left text-xs text-[var(--text-muted)]">
						<th className="py-2 pr-4 font-medium">利用者</th>
						{ids.map((id) => (
							<th key={id} className="px-4 py-2 text-right font-medium">
								{nameOf(id)} のキー
							</th>
						))}
						<th className="py-2 pl-4 text-right font-medium">合計</th>
					</tr>
				</thead>
				<tbody>
					{ids.map((userId) => {
						const total = pairs
							.filter((row) => row.userId === userId)
							.reduce((sum, row) => sum + row.costNano, 0);
						return (
							<tr key={userId} className="border-t border-[var(--border)]">
								<td className="py-2.5 pr-4">{nameOf(userId)}</td>
								{ids.map((ownerId) => {
									const row = cell(userId, ownerId);
									const self = userId === ownerId;
									return (
										<td
											key={ownerId}
											className="px-4 py-2.5 text-right tabular-nums"
											title={self ? "自分のキーなので請求しません" : undefined}
										>
											{row ? (
												<span
													className={
														self ? "text-[var(--text-muted)]" : undefined
													}
												>
													{formatUsd(row.costNano)}
												</span>
											) : (
												<span className="text-[var(--text-subtle)]">—</span>
											)}
										</td>
									);
								})}
								<td className="py-2.5 pl-4 text-right font-medium tabular-nums">
									{formatUsd(total)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
