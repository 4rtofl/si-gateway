import type {
	SigwKeyApiKeyInput,
	SigwKeyInput,
	SigwKeyJson,
} from "@api/types.ts";
import { type FormEvent, useState } from "react";
import { toDateString } from "@/app/format";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Checkbox, Form, Input, Textarea } from "@/components/ui/form";
import { Field } from "./field.tsx";

/** 代理専用のチェックボックスの説明。発行の画面と、詳細の画面の登録で同じものを使う */
export const DELEGATED_ONLY_DESCRIPTION =
	"Bobert からの呼び出しでだけ使えます。登録したあとは変えられません。";

/** API キーの入力欄(パスワードの形)と、代理専用のチェックボックス */
export function ApiKeyInput({
	label,
	hint,
	apiKey,
	delegatedOnly,
	onChange,
	required,
}: {
	label: string;
	hint: string;
	apiKey: string;
	delegatedOnly: boolean;
	onChange: (next: { apiKey: string; delegatedOnly: boolean }) => void;
	required?: boolean;
}) {
	return (
		<div className="space-y-2">
			<Field label={label} hint={hint}>
				{(id) => (
					<Input
						id={id}
						type="password"
						value={apiKey}
						onChange={(event) =>
							onChange({ apiKey: event.target.value, delegatedOnly })
						}
						autoComplete="off"
						showPasswordToggle
						required={required}
					/>
				)}
			</Field>
			<Checkbox
				checked={delegatedOnly}
				onChange={(event) =>
					onChange({ apiKey, delegatedOnly: event.target.checked })
				}
				label="代理専用"
				description={DELEGATED_ONLY_DESCRIPTION}
			/>
		</div>
	);
}

function initialDate(ms: number | null | undefined): Date | null {
	return ms ? new Date(ms) : null;
}

/**
 * sigw キーの発行と変更に使うフォーム。issuing なら、プロバイダごとに API キーを入れられる(発行のとき。1つ以上)。
 * 発行したあとの登録・差し替え・外すは、キーの詳細の画面でする
 */
export function SigwKeyForm({
	initial,
	issuing = false,
	submitLabel,
	onSubmit,
}: {
	initial?: SigwKeyJson;
	issuing?: boolean;
	submitLabel: string;
	onSubmit: (input: SigwKeyInput) => Promise<void>;
}) {
	const { me } = useMe();
	const toast = useToast();
	// プロバイダごとの API キー。空のプロバイダは登録しない
	const [apiKeys, setApiKeys] = useState<
		Record<string, { apiKey: string; delegatedOnly: boolean }>
	>({});
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
		const entered: SigwKeyApiKeyInput[] = Object.entries(apiKeys)
			.filter(([, value]) => value.apiKey.trim() !== "")
			.map(([provider, value]) => ({
				provider,
				apiKey: value.apiKey.trim(),
				delegatedOnly: value.delegatedOnly,
			}));
		if (issuing && entered.length === 0) {
			toast("API キーを1つ以上入れてください。", "error");
			return;
		}
		setBusy(true);
		try {
			await onSubmit({
				apiKeys: issuing ? entered : undefined,
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
			{issuing &&
				me.providers.map((provider) => (
					<ApiKeyInput
						key={provider.id}
						label={`${provider.label} の API キー`}
						hint="空なら、このプロバイダは呼べません。登録したあとは、末尾4文字しか表示しません。"
						apiKey={apiKeys[provider.id]?.apiKey ?? ""}
						delegatedOnly={apiKeys[provider.id]?.delegatedOnly ?? false}
						onChange={(next) =>
							setApiKeys((current) => ({ ...current, [provider.id]: next }))
						}
					/>
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
			<Button type="submit" isLoading={busy} fullWidth>
				{submitLabel}
			</Button>
		</Form>
	);
}
