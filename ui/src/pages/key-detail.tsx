import type {
	LinkedProviderKeyJson,
	ProviderKeyJson,
	SigwKeyJson,
	UsageEventJson,
} from "@api/types.ts";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "@/app/api";
import { formatDateTime } from "@/app/format";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { useData } from "@/app/use-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { EventsTable } from "@/parts/events";
import { PageHeader, Section } from "@/parts/layout";
import { providerKeyOptionLabel, SigwKeyForm } from "@/parts/sigw-key-form";
import { LimitBar } from "@/parts/usage";
import { keyState } from "./keys.tsx";

export function KeyDetailPage() {
	const { id = "" } = useParams();
	const { me } = useMe();
	const toast = useToast();
	const navigate = useNavigate();
	const key = useData<SigwKeyJson>(`/sigw-keys/${id}`);
	const providerKeys = useData<ProviderKeyJson[]>("/provider-keys");
	const [adding, setAdding] = useState("");
	const [busy, setBusy] = useState(false);
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
	const issuer = data.createdBy === me.user.id;
	// 変えられるのは、発行した人と、結び付いたプロバイダキーの所有者
	const editable =
		issuer ||
		data.providerKeys.some((providerKey) => providerKey.ownerId === me.user.id);
	const active = data.revokedAt === null;
	const providerLabel = (provider: string) =>
		me.providers.find((item) => item.id === provider)?.label ?? provider;
	// 足せるのは、まだ結び付いていないプロバイダの、有効なプロバイダキー。
	// 発行した人は誰のキーでも、所有者は自分のキーだけを足せる
	const candidates = (providerKeys.data ?? []).filter(
		(providerKey) =>
			providerKey.disabledAt === null &&
			!data.providerKeys.some(
				(item) => item.provider === providerKey.provider,
			) &&
			(issuer || providerKey.ownerId === me.user.id),
	);
	const addingId = candidates.some((item) => item.id === adding)
		? adding
		: (candidates[0]?.id ?? "");

	const addProviderKey = async () => {
		if (!addingId) return;
		setBusy(true);
		try {
			await api(`/sigw-keys/${data.id}/provider-keys`, {
				method: "POST",
				body: { providerKeyId: addingId },
			});
			toast("足しました。反映まで最大30秒かかります。");
			await Promise.all([key.reload(), providerKeys.reload()]);
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		} finally {
			setBusy(false);
		}
	};

	const removeProviderKey = async (providerKey: LinkedProviderKeyJson) => {
		if (
			!window.confirm(
				`${providerLabel(providerKey.provider)} · ${providerKey.label} を、この sigw キーから外しますか？`,
			)
		)
			return;
		try {
			await api(`/sigw-keys/${data.id}/provider-keys/${providerKey.id}`, {
				method: "DELETE",
			});
			toast("外しました。反映まで最大30秒かかります。");
			await Promise.all([key.reload(), providerKeys.reload()]);
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};

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
			<Section title="プロバイダキー">
				<ul className="divide-y divide-[var(--border)]">
					{data.providerKeys.map((providerKey) => (
						<li
							key={providerKey.id}
							className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
						>
							<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
								<span className="font-medium">
									{providerLabel(providerKey.provider)} · {providerKey.label}
								</span>
								<span className="text-xs text-[var(--text-muted)]">
									{providerKey.ownerName}
								</span>
								{providerKey.delegatedOnly && <Badge>代理専用</Badge>}
								{providerKey.disabled && <Badge tone="danger">無効</Badge>}
							</div>
							{active &&
								data.providerKeys.length > 1 &&
								(issuer || providerKey.ownerId === me.user.id) && (
									<Button
										variant="secondary"
										size="sm"
										onClick={() => removeProviderKey(providerKey)}
									>
										外す
									</Button>
								)}
						</li>
					))}
				</ul>
				{editable && active && candidates.length > 0 && (
					<div className="mt-3 flex max-w-md items-center gap-2">
						<Select
							aria-label="足すプロバイダキー"
							value={addingId}
							onChange={(event) => setAdding(event.target.value)}
							options={candidates.map((providerKey) => ({
								value: providerKey.id,
								label: `${providerLabel(providerKey.provider)} · ${providerKeyOptionLabel(providerKey)}`,
							}))}
							className="flex-1"
						/>
						<Button size="sm" isLoading={busy} onClick={addProviderKey}>
							足す
						</Button>
					</div>
				)}
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
