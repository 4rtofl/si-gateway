import type { SigwKeyJson, UsageEventJson } from "@api/types.ts";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "@/app/api";
import { formatDateTime } from "@/app/format";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { useData } from "@/app/use-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EventsTable } from "@/parts/events";
import { PageHeader, Section } from "@/parts/layout";
import { SigwKeyForm } from "@/parts/sigw-key-form";
import { LimitBar } from "@/parts/usage";
import { keyState } from "./keys.tsx";

export function KeyDetailPage() {
	const { id = "" } = useParams();
	const { me } = useMe();
	const toast = useToast();
	const navigate = useNavigate();
	const key = useData<SigwKeyJson>(`/sigw-keys/${id}`);
	const events = useData<UsageEventJson[]>(
		`/usage/events?key=${id}&month=${me.month}&limit=200`,
	);

	if (key.error) {
		return (
			<Alert tone="danger">
				<AlertDescription>{key.error}</AlertDescription>
			</Alert>
		);
	}
	if (!key.data) {
		return <Skeleton className="h-64 w-full" />;
	}
	const data = key.data;
	const state = keyState(data);
	const editable = data.createdBy === me.user.id || data.ownerId === me.user.id;
	const active = data.revokedAt === null;

	const revoke = async () => {
		if (
			!window.confirm(`「${data.purpose}」を無効にしますか？元には戻せません。`)
		)
			return;
		try {
			await api(`/sigw-keys/${data.id}`, { method: "DELETE" });
			toast("無効にしました");
			navigate("/keys");
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};

	return (
		<>
			<PageHeader
				title={data.purpose}
				actions={
					editable &&
					active && (
						<Button variant="destructive" size="sm" onClick={revoke}>
							無効にする
						</Button>
					)
				}
			/>
			<Section>
				<dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
					<div>
						<dt className="text-xs text-[var(--text-muted)]">状態</dt>
						<dd className="mt-1">
							<Badge tone={state.tone}>{state.label}</Badge>
						</dd>
					</div>
					<div>
						<dt className="text-xs text-[var(--text-muted)]">プロバイダキー</dt>
						<dd className="mt-1">
							{
								me.providers.find((provider) => provider.id === data.provider)
									?.label
							}{" "}
							· {data.providerKeyLabel}({data.ownerName})
						</dd>
					</div>
					<div>
						<dt className="text-xs text-[var(--text-muted)]">トークン</dt>
						<dd className="mt-1 font-mono text-xs">{data.tokenHint}</dd>
					</div>
					<div>
						<dt className="text-xs text-[var(--text-muted)]">今月の使用額</dt>
						<dd className="mt-1">
							<LimitBar
								spent={data.monthSpendNano}
								limit={data.monthlyLimitNano}
							/>
						</dd>
					</div>
					<div>
						<dt className="text-xs text-[var(--text-muted)]">発行</dt>
						<dd className="mt-1">
							{data.createdByName}、{formatDateTime(data.createdAt)}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-[var(--text-muted)]">使えるモデル</dt>
						<dd className="mt-1 font-mono text-xs">
							{data.allowedModels?.join(", ") ?? "制限なし"}
						</dd>
					</div>
				</dl>
			</Section>
			{editable && active && (
				<Section title="設定を変える">
					<div className="max-w-md">
						<SigwKeyForm
							initial={data}
							submitLabel="保存"
							onSubmit={async (input) => {
								try {
									await api(`/sigw-keys/${data.id}`, {
										method: "PATCH",
										body: input,
									});
									toast("保存しました。反映まで最大30秒かかります。");
									await key.reload();
								} catch (error) {
									toast(
										error instanceof Error ? error.message : String(error),
										"error",
									);
								}
							}}
						/>
					</div>
				</Section>
			)}
			<Section
				title="今月の呼び出し"
				actions={
					<Link
						to="/keys"
						className="text-sm text-[var(--text-secondary)] hover:underline"
					>
						キーの一覧
					</Link>
				}
			>
				{events.data ? (
					<EventsTable events={events.data} keys={[data]} />
				) : (
					<Skeleton className="h-32 w-full" />
				)}
			</Section>
		</>
	);
}
