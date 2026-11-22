import type { ProviderKeyJson, SigwKeyInput, SigwKeyJson } from "@api/types.ts";
import { type FormEvent, useState } from "react";
import { toDateString } from "@/app/format";
import { useMe } from "@/app/me";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Form, Input, Select, Textarea } from "@/components/ui/form";
import { Field } from "./field.tsx";

/** プロバイダキーを選ぶときの表示。「メイン(あま) · 代理専用」 */
export function providerKeyOptionLabel(key: ProviderKeyJson): string {
	return `${key.label}(${key.ownerName})${key.delegatedOnly ? " · 代理専用" : ""}`;
}

function initialDate(ms: number | null | undefined): Date | null {
	return ms ? new Date(ms) : null;
}

/**
 * sigw キーの発行と変更に使うフォーム。providerKeys を渡すと、プロバイダキーを選べる(発行のとき)。
 * プロバイダキーは、プロバイダごとに1つずつ選ぶ。発行したあとの足し外しは、キーの詳細の画面でする
 */
export function SigwKeyForm({
	initial,
	providerKeys,
	submitLabel,
	onSubmit,
}: {
	initial?: SigwKeyJson;
	providerKeys?: ProviderKeyJson[];
	submitLabel: string;
	onSubmit: (input: SigwKeyInput) => Promise<void>;
}) {
	const { me } = useMe();
	// プロバイダごとの選択。空の文字列は「使わない」。最初は、最初のプロバイダキーだけを選んでおく
	const providers = me.providers.filter((provider) =>
		providerKeys?.some((key) => key.provider === provider.id),
	);
	const [selected, setSelected] = useState<Record<string, string>>(() => {
		const first = providerKeys?.[0];
		return first ? { [first.provider]: first.id } : {};
	});
	const providerKeyIds = Object.values(selected).filter((id) => id !== "");
	const [purpose, setPurpose] = useState(initial?.purpose ?? "");
	const [models, setModels] = useState(
		initial?.allowedModels?.join("\n") ?? "",
	);
	const [limit, setLimit] = useState(
		initial?.monthlyLimitNano ? String(initial.monthlyLimitNano / 1e9) : "",
	);
	const [expires, setExpires] = useState<Date | null>(
		initialDate(initial?.expiresAt),
	);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			await onSubmit({
				providerKeyIds: providerKeys ? providerKeyIds : undefined,
				purpose,
				allowedModels: models.split(/[\s,]+/).filter((value) => value !== ""),
				monthlyLimitUsd: limit.trim() === "" ? null : Number(limit),
				expiresOn: expires ? toDateString(expires) : null,
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<Form onSubmit={submit}>
			{providerKeys &&
				providers.map((provider) => (
					<Field key={provider.id} label={`${provider.label} のプロバイダキー`}>
						{(id) => (
							<Select
								id={id}
								value={selected[provider.id] ?? ""}
								onChange={(event) =>
									setSelected((current) => ({
										...current,
										[provider.id]: event.target.value,
									}))
								}
								options={[
									{ value: "", label: "使わない" },
									...providerKeys
										.filter((key) => key.provider === provider.id)
										.map((key) => ({
											value: key.id,
											label: providerKeyOptionLabel(key),
										})),
								]}
							/>
						)}
					</Field>
				))}
			<Field label="目的">
				{(id) => (
					<Input
						id={id}
						value={purpose}
						onChange={(event) => setPurpose(event.target.value)}
						placeholder="記事要約バッチ"
						maxLength={80}
						required
					/>
				)}
			</Field>
			<Field
				label="使えるモデル"
				hint="空なら制限なし。* は任意の文字列に一致します。"
			>
				{(id) => (
					<Textarea
						id={id}
						value={models}
						onChange={(event) => setModels(event.target.value)}
						placeholder={"claude-sonnet-*\ngpt-5-mini"}
						rows={3}
					/>
				)}
			</Field>
			<Field label="月の上限額(USD)" hint="3人の合計。空なら上限なし。">
				{(id) => (
					<Input
						id={id}
						type="number"
						min="0"
						step="0.01"
						inputMode="decimal"
						value={limit}
						onChange={(event) => setLimit(event.target.value)}
					/>
				)}
			</Field>
			<Field label="有効期限">
				{() => (
					<div className="flex items-center gap-2">
						<DatePicker
							value={expires}
							onChange={setExpires}
							placeholder="期限なし"
							locale="ja-JP"
							minDate={new Date()}
							className="flex-1"
						/>
						{expires && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setExpires(null)}
							>
								期限をなくす
							</Button>
						)}
					</div>
				)}
			</Field>
			<Button
				type="submit"
				isLoading={busy}
				fullWidth
				disabled={providerKeys !== undefined && providerKeyIds.length === 0}
			>
				{submitLabel}
			</Button>
		</Form>
	);
}
