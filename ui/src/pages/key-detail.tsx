import type { ProviderJson, SigwKeyJson, UsageEventJson } from "@api/types.ts";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "@/app/api";
import { formatDateTime } from "@/app/format";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { useData } from "@/app/use-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import {
	Sheet,
	SheetBody,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { EventsTable } from "@/parts/events";
import { PageHeader, Section } from "@/parts/layout";
import { ApiKeyInput, SigwKeyForm } from "@/parts/sigw-key-form";
import { LimitBar } from "@/parts/usage";
import { keyState } from "./keys.tsx";

/** sigw キーに、1つのプロバイダの API キーを登録する(登録済みなら差し替える)シート */
function ApiKeySheet({
	sigwKeyId,
	provider,
	onOpenChange,
	onSaved,
}: {
	sigwKeyId: string;
	provider: ProviderJson | null;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	const toast = useToast();
	const [value, setValue] = useState({ apiKey: "", delegatedOnly: false });
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!provider) return;
		setBusy(true);
		try {
			await api(`/sigw-keys/${sigwKeyId}/providers/${provider.id}`, {
				method: "PUT",
				body: value,
			});
			toast("登録しました。反映まで最大30秒かかります。");
			setValue({ apiKey: "", delegatedOnly: false });
			onOpenChange(false);
			onSaved();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		} finally {
			setBusy(false);
		}
	};
	return (
		<Sheet
			open={provider !== null}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) setValue({ apiKey: "", delegatedOnly: false });
			}}
		>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>{provider?.label} の API キーを登録</SheetTitle>
				</SheetHeader>
				<SheetBody>
					<Form onSubmit={submit}>
						<ApiKeyInput
							label="API キー"
							hint="登録したあとは、末尾4文字しか表示しません。"
							apiKey={value.apiKey}
							delegatedOnly={value.delegatedOnly}
							onChange={setValue}
							required
						/>
						<Button type="submit" isLoading={busy} fullWidth>
							登録
						</Button>
					</Form>
				</SheetBody>
			</SheetContent>
		</Sheet>
	);
}

export function KeyDetailPage() {
	const { id = "" } = useParams();
	const { me } = useMe();
	const toast = useToast();
	const navigate = useNavigate();
	const key = useData<SigwKeyJson>(`/sigw-keys/${id}`);
	// API キーを登録するプロバイダ。null ならシートを閉じている
	const [registering, setRegistering] = useState<ProviderJson | null>(null);
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
	// 変えられるか(発行した人と、API キーを登録した人)は、API が決める
	const editable = data.editable;
	const active = data.revokedAt === null;

	const removeProviderKey = async (provider: ProviderJson) => {
		if (
			!window.confirm(
				`${provider.label} の API キーを外しますか？外したキーは削除され、元には戻せません。この sigw キーでは ${provider.label} を呼べなくなります。`,
			)
		)
			return;
		try {
			await api(`/sigw-keys/${data.id}/providers/${provider.id}`, {
				method: "DELETE",
			});
			toast("外しました。反映まで最大30秒かかります。");
			await key.reload();
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

	// 削除は、無効にしたキーでもできる
	const remove = async () => {
		if (
			!window.confirm(`「${data.purpose}」を削除しますか？元には戻せません。`)
		)
			return;
		try {
			await api(`/sigw-keys/${data.id}/delete`, { method: "POST" });
			toast("削除しました");
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
					editable && (
						<div className="flex items-center gap-2">
							{active && (
								<Button variant="destructive" size="sm" onClick={revoke}>
									無効にする
								</Button>
							)}
							<Button variant="destructive" size="sm" onClick={remove}>
								削除
							</Button>
						</div>
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
			<Section title="API キー">
				<ul className="divide-y divide-[var(--border)]">
					{me.providers.map((provider) => {
						const providerKey = data.providerKeys.find(
							(item) => item.provider === provider.id,
						);
						return (
							<li
								key={provider.id}
								className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
							>
								<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
									<span className="font-medium">{provider.label}</span>
									{providerKey ? (
										<>
											<span className="text-xs text-[var(--text-muted)]">
												末尾 {providerKey.keyLast4}({providerKey.ownerName})
											</span>
											{providerKey.delegatedOnly && <Badge>代理専用</Badge>}
											{providerKey.disabled && (
												<Badge tone="danger">無効</Badge>
											)}
										</>
									) : (
										<span className="text-xs text-[var(--text-muted)]">
											未登録
										</span>
									)}
								</div>
								{editable && active && (
									<div className="flex items-center gap-2">
										{providerKey ? (
											<>
												<Button
													variant="secondary"
													size="sm"
													onClick={() => setRegistering(provider)}
												>
													差し替える
												</Button>
												<Button
													variant="secondary"
													size="sm"
													onClick={() => removeProviderKey(provider)}
												>
													外す
												</Button>
											</>
										) : (
											<Button
												size="sm"
												onClick={() => setRegistering(provider)}
											>
												登録
											</Button>
										)}
									</div>
								)}
							</li>
						);
					})}
				</ul>
			</Section>
			<ApiKeySheet
				sigwKeyId={data.id}
				provider={registering}
				onOpenChange={(open) => {
					if (!open) setRegistering(null);
				}}
				onSaved={() => void key.reload()}
			/>
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
