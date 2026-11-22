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
	placeholder,
}: {
	label: string;
	hint: string;
	placeholder?: string;
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
						placeholder={placeholder}
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
 * sigw キーの発行と変更に使うフォーム。apiKeyMode を渡すと、プロバイダごとに API キーを入れられる。
 * - "issue": 発行のとき。1つ以上入れる
 * - "edit": 一覧の「編集」のとき。入れたプロバイダだけ登録・差し替えする。0個でもよい。外すのは、キーの詳細の画面でする
 *
 * 入れた API キーは input.apiKeys で渡す。apiKeyMode がなければ undefined
 */
export function SigwKeyForm({
	initial,
	apiKeyMode,
	submitLabel,
	onSubmit,
}: {
	initial?: SigwKeyJson;
	apiKeyMode?: "issue" | "edit";
	submitLabel: string;
	onSubmit: (input: SigwKeyInput) => Promise<void>;
}) {
	const { me } = useMe();
	const toast = useToast();
	// プロバイダごとの API キー。空のプロバイダは登録しない。
	// 登録済みのプロバイダの代理専用は、今の値から始める(新しいキーを入れたときだけ使う)
	const [apiKeys, setApiKeys] = useState<
		Record<string, { apiKey: string; delegatedOnly: boolean }>
	>(() =>
		Object.fromEntries(
			(initial?.providerKeys ?? []).map((providerKey) => [
				providerKey.provider,
				{ apiKey: "", delegatedOnly: providerKey.delegatedOnly },
			]),
		),
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
		const entered: SigwKeyApiKeyInput[] = Object.entries(apiKeys)
			.filter(([, value]) => value.apiKey.trim() !== "")
			.map(([provider, value]) => ({
				provider,
				apiKey: value.apiKey.trim(),
				delegatedOnly: value.delegatedOnly,
			}));
		if (apiKeyMode === "issue" && entered.length === 0) {
			toast("API キーを1つ以上入れてください。", "error");
			return;
		}
		setBusy(true);
		try {
			await onSubmit({
				apiKeys: apiKeyMode ? entered : undefined,
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
			{apiKeyMode &&
				me.providers.map((provider) => {
					// 編集のときだけ、登録済みのキーを出す
					const registered =
						apiKeyMode === "edit"
							? initial?.providerKeys.find(
									(providerKey) => providerKey.provider === provider.id,
								)
							: undefined;
					return (
						<ApiKeyInput
							key={provider.id}
							label={`${provider.label} の API キー`}
							hint={
								registered
									? "空のままなら、今のキーを使い続けます。入れると差し替え、今のキーは削除します。"
									: "空なら、このプロバイダは呼べません。登録したあとは、末尾4文字しか表示しません。"
							}
							placeholder={
								registered
									? `末尾 ${registered.keyLast4}(${registered.ownerName})`
									: undefined
							}
							apiKey={apiKeys[provider.id]?.apiKey ?? ""}
							delegatedOnly={apiKeys[provider.id]?.delegatedOnly ?? false}
							onChange={(next) =>
								setApiKeys((current) => ({ ...current, [provider.id]: next }))
							}
						/>
					);
				})}
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
