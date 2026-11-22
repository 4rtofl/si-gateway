import type { SigwKeyJson } from "@api/types.ts";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "@/app/api";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { useData } from "@/app/use-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetBody,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { SecretReveal } from "@/parts/copy";
import { PageHeader, Section } from "@/parts/layout";
import { SigwKeyForm } from "@/parts/sigw-key-form";
import { LimitBar } from "@/parts/usage";

/** sigw キーに登録した API キーを、1行で書く。「Anthropic · 末尾 abcd(あま)、OpenRouter · 末尾 wxyz(…)」 */
export function linkedProviderKeysText(
	key: SigwKeyJson,
	providerLabel: (id: string) => string,
): string {
	return key.providerKeys
		.map(
			(providerKey) =>
				`${providerLabel(providerKey.provider)} · 末尾 ${providerKey.keyLast4}(${providerKey.ownerName})${providerKey.disabled ? "・無効" : ""}`,
		)
		.join("、");
}

export function keyState(key: SigwKeyJson): {
	label: string;
	tone: "success" | "neutral" | "danger";
} {
	if (key.revokedAt !== null) return { label: "無効", tone: "neutral" };
	// 使える API キーが1つもないとき。一部だけが無効なら、ほかのプロバイダは呼べるので「有効」のままにする
	if (key.providerKeys.every((providerKey) => providerKey.disabled))
		return { label: "API キーが未登録", tone: "danger" };
	if (key.expiresAt !== null && key.expiresAt < Date.now())
		return { label: "期限切れ", tone: "danger" };
	return { label: "有効", tone: "success" };
}

function SigwKeySheet({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
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
							issuing
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
	const sigwKeys = useData<SigwKeyJson[]>("/sigw-keys");
	const [sigwOpen, setSigwOpen] = useState(false);
	const providerLabel = (id: string) =>
		me.providers.find((provider) => provider.id === id)?.label ?? id;

	// 削除は、無効にしたキーでもできる
	const deleteSigwKey = async (key: SigwKeyJson) => {
		if (
			!window.confirm(`「${key.purpose}」を削除しますか？元には戻せません。`)
		) {
			return;
		}
		try {
			await api(`/sigw-keys/${key.id}/delete`, { method: "POST" });
			toast("削除しました");
			await sigwKeys.reload();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};

	return (
		<>
			<PageHeader title="キー" />
			<Section
				title="sigw キー"
				actions={
					<Button size="sm" onClick={() => setSigwOpen(true)}>
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
											{linkedProviderKeysText(key, providerLabel)}
										</p>
									</div>
									<LimitBar
										spent={key.monthSpendNano}
										limit={key.monthlyLimitNano}
									/>
									{key.editable && (
										<Button
											variant="destructive"
											size="sm"
											onClick={() => deleteSigwKey(key)}
										>
											削除
										</Button>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</Section>

			<SigwKeySheet
				open={sigwOpen}
				onOpenChange={setSigwOpen}
				onCreated={() => void sigwKeys.reload()}
			/>
		</>
	);
}
