import type { ProviderKeyJson, SigwKeyInput, SigwKeyJson } from "@api/types.ts";
import { type FormEvent, useState } from "react";
import { toDateString } from "@/app/format";
import { useMe } from "@/app/me";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Form, Input, Select, Textarea } from "@/components/ui/form";
import { Field } from "./field.tsx";

function initialDate(ms: number | null | undefined): Date | null {
	return ms ? new Date(ms) : null;
}

/** sigw キーの発行と変更に使うフォーム。providerKeys を渡すと、プロバイダキーを選べる(発行のとき) */
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
	const providerLabel = (id: string) =>
		me.providers.find((provider) => provider.id === id)?.label ?? id;
	const [providerKeyId, setProviderKeyId] = useState(
		providerKeys?.[0]?.id ?? "",
	);
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
				providerKeyId: providerKeys ? providerKeyId : undefined,
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
			{providerKeys && (
				<Field label="プロバイダキー">
					{(id) => (
						<Select
							id={id}
							value={providerKeyId}
							onChange={(event) => setProviderKeyId(event.target.value)}
							options={providerKeys.map((key) => ({
								value: key.id,
								label: `${providerLabel(key.provider)} · ${key.label}(${key.ownerName})${key.delegatedOnly ? " · 代理専用" : ""}`,
							}))}
						/>
					)}
				</Field>
			)}
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
				disabled={providerKeys !== undefined && providerKeyId === ""}
			>
				{submitLabel}
			</Button>
		</Form>
	);
}
