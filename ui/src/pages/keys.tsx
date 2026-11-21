import type { ProviderKeyJson, SigwKeyJson } from "@api/types.ts";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { api } from "@/app/api";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { useData } from "@/app/use-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Form, Input, Select } from "@/components/ui/form";
import {
	Sheet,
	SheetBody,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { SecretReveal } from "@/parts/copy";
import { Field } from "@/parts/field";
import { PageHeader, Section } from "@/parts/layout";
import { SigwKeyForm } from "@/parts/sigw-key-form";
import { LimitBar } from "@/parts/usage";

export function keyState(key: SigwKeyJson): {
	label: string;
	tone: "success" | "neutral" | "danger";
} {
	if (key.revokedAt !== null) return { label: "無効", tone: "neutral" };
	if (key.providerKeyDisabled)
		return { label: "プロバイダキーが無効", tone: "danger" };
	if (key.expiresAt !== null && key.expiresAt < Date.now())
		return { label: "期限切れ", tone: "danger" };
	return { label: "有効", tone: "success" };
}

function ProviderKeySheet({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: () => void;
}) {
	const { me } = useMe();
	const toast = useToast();
	const [provider, setProvider] = useState(me.providers[0]?.id ?? "openai");
	const [label, setLabel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			await api("/provider-keys", {
				method: "POST",
				body: { provider, label, apiKey },
			});
			toast("プロバイダキーを登録しました");
			setApiKey("");
			setLabel("");
			onOpenChange(false);
			onCreated();
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
					<SheetTitle>プロバイダキーを登録</SheetTitle>
				</SheetHeader>
				<SheetBody>
					<Form onSubmit={submit}>
						<Field label="プロバイダ">
							{(id) => (
								<Select
									id={id}
									value={provider}
									onChange={(event) =>
										setProvider(event.target.value as typeof provider)
									}
									options={me.providers.map((item) => ({
										value: item.id,
										label: item.label,
									}))}
								/>
							)}
						</Field>
						<Field label="名前">
							{(id) => (
								<Input
									id={id}
									value={label}
									onChange={(event) => setLabel(event.target.value)}
									placeholder="メイン"
									maxLength={60}
								/>
							)}
						</Field>
						<Field
							label="API キー"
							hint="登録したあとは、末尾4文字しか表示しません。"
						>
							{(id) => (
								<Input
									id={id}
									type="password"
									value={apiKey}
									onChange={(event) => setApiKey(event.target.value)}
									autoComplete="off"
									showPasswordToggle
									required
								/>
							)}
						</Field>
						<Button type="submit" isLoading={busy} fullWidth>
							登録
						</Button>
					</Form>
				</SheetBody>
			</SheetContent>
		</Sheet>
	);
}

function SigwKeySheet({
	open,
	onOpenChange,
	providerKeys,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	providerKeys: ProviderKeyJson[];
	onCreated: () => void;
}) {
	const toast = useToast();
	const [token, setToken] = useState<string | null>(null);
	return (
		<Sheet
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) setToken(null);
			}}
		>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>sigw キーを発行</SheetTitle>
				</SheetHeader>
				<SheetBody>
					{token ? (
						<div className="space-y-4">
							<SecretReveal
								value={token}
								note="このトークンは今だけ表示します。"
							/>
							<p className="text-sm text-[var(--text-secondary)]">
								API
								キーには「このトークン.個人トークン」を入れます。個人トークンは
								<Link to="/settings" className="underline">
									設定
								</Link>
								にあります。
							</p>
							<Button
								variant="secondary"
								fullWidth
								onClick={() => onOpenChange(false)}
							>
								閉じる
							</Button>
						</div>
					) : (
						<SigwKeyForm
							providerKeys={providerKeys}
							submitLabel="発行"
							onSubmit={async (input) => {
								try {
									const result = await api<{ id: string; token: string }>(
										"/sigw-keys",
										{
											method: "POST",
											body: input,
										},
									);
									setToken(result.token);
									onCreated();
								} catch (error) {
									toast(
										error instanceof Error ? error.message : String(error),
										"error",
									);
								}
							}}
						/>
					)}
				</SheetBody>
			</SheetContent>
		</Sheet>
	);
}

export function KeysPage() {
	const { me } = useMe();
	const toast = useToast();
	const providerKeys = useData<ProviderKeyJson[]>("/provider-keys");
	const sigwKeys = useData<SigwKeyJson[]>("/sigw-keys");
	const [providerOpen, setProviderOpen] = useState(false);
	const [sigwOpen, setSigwOpen] = useState(false);
	const activeProviderKeys =
		providerKeys.data?.filter((key) => key.disabledAt === null) ?? [];

	const toggleProviderKey = async (key: ProviderKeyJson) => {
		const disable = key.disabledAt === null;
		if (
			disable &&
			!window.confirm(
				`${key.label} を無効にしますか？紐づく sigw キーもすべて使えなくなります。`,
			)
		) {
			return;
		}
		try {
			await api(`/provider-keys/${key.id}/${disable ? "disable" : "enable"}`, {
				method: "POST",
			});
			toast(disable ? "無効にしました" : "有効に戻しました");
			await Promise.all([providerKeys.reload(), sigwKeys.reload()]);
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};

	return (
		<>
			<PageHeader title="キー" />
			<Section
				title="プロバイダキー"
				actions={
					<Button size="sm" onClick={() => setProviderOpen(true)}>
						登録
					</Button>
				}
			>
				{!providerKeys.data ? (
					<Skeleton className="h-20 w-full" />
				) : providerKeys.data.length === 0 ? (
					<p className="text-sm text-[var(--text-muted)]">
						プロバイダキーはまだありません。クレジットを買ったキーを登録すると、sigw
						キーを発行できます。
					</p>
				) : (
					<ul className="divide-y divide-[var(--border)]">
						{providerKeys.data.map((key) => (
							<li
								key={key.id}
								className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2 text-sm">
										<span className="font-medium">
											{
												me.providers.find(
													(provider) => provider.id === key.provider,
												)?.label
											}{" "}
											· {key.label}
										</span>
										<span className="font-mono text-xs text-[var(--text-muted)]">
											{key.keyHint}
										</span>
										{key.disabledAt !== null && <Badge>無効</Badge>}
									</div>
									<p className="text-xs text-[var(--text-muted)]">
										{key.ownerName}
									</p>
								</div>
								{key.ownerId === me.user.id && (
									<Button
										variant={
											key.disabledAt === null ? "destructive" : "secondary"
										}
										size="sm"
										onClick={() => toggleProviderKey(key)}
									>
										{key.disabledAt === null ? "無効にする" : "有効に戻す"}
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
			</Section>

			<Section
				title="sigw キー"
				actions={
					<Button
						size="sm"
						onClick={() => setSigwOpen(true)}
						disabled={activeProviderKeys.length === 0}
					>
						発行
					</Button>
				}
			>
				{!sigwKeys.data ? (
					<Skeleton className="h-32 w-full" />
				) : sigwKeys.data.length === 0 ? (
					<p className="text-sm text-[var(--text-muted)]">
						sigw キーはまだありません。目的ごとに発行してください。
					</p>
				) : (
					<ul className="divide-y divide-[var(--border)]">
						{sigwKeys.data.map((key) => {
							const state = keyState(key);
							return (
								<li
									key={key.id}
									className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
								>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2 text-sm">
											<Link
												to={`/keys/${key.id}`}
												className="font-medium hover:underline"
											>
												{key.purpose}
											</Link>
											<Badge tone={state.tone}>{state.label}</Badge>
										</div>
										<p className="text-xs text-[var(--text-muted)]">
											{
												me.providers.find(
													(provider) => provider.id === key.provider,
												)?.label
											}{" "}
											· {key.providerKeyLabel}({key.ownerName})
										</p>
									</div>
									<LimitBar
										spent={key.monthSpendNano}
										limit={key.monthlyLimitNano}
									/>
								</li>
							);
						})}
					</ul>
				)}
			</Section>

			<ProviderKeySheet
				open={providerOpen}
				onOpenChange={setProviderOpen}
				onCreated={() => providerKeys.reload()}
			/>
			{providerKeys.data && (
				<SigwKeySheet
					open={sigwOpen}
					onOpenChange={setSigwOpen}
					providerKeys={activeProviderKeys}
					onCreated={() =>
						void Promise.all([sigwKeys.reload(), providerKeys.reload()])
					}
				/>
			)}
		</>
	);
}
