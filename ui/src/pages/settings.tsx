import type { CliTokenJson } from "@api/types.ts";
import { type FormEvent, useState } from "react";
import { api } from "@/app/api";
import { formatDateTime } from "@/app/format";
import { useMe } from "@/app/me";
import { useToast } from "@/app/toast";
import { useData } from "@/app/use-data";
import { Button } from "@/components/ui/button";
import { Form, Input } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeBlock, SecretReveal } from "@/parts/copy";
import { Field } from "@/parts/field";
import { PageHeader, Section } from "@/parts/layout";

function PersonalToken() {
	const { me, reload } = useMe();
	const toast = useToast();
	const [token, setToken] = useState<string | null>(null);
	const rotate = async () => {
		if (
			me.user.personalTokenHint &&
			!window.confirm(
				"個人トークンを発行し直しますか？今のトークンは使えなくなります。",
			)
		) {
			return;
		}
		try {
			const result = await api<{ token: string }>("/me/personal-token", {
				method: "POST",
			});
			setToken(result.token);
			await reload();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};
	return (
		<Section
			title="個人トークン"
			actions={
				<Button
					size="sm"
					variant={me.user.personalTokenHint ? "secondary" : "primary"}
					onClick={rotate}
				>
					{me.user.personalTokenHint ? "発行し直す" : "発行"}
				</Button>
			}
		>
			<p className="mb-3 text-sm text-[var(--text-secondary)]">
				API キーには「sigw キー.個人トークン」を入れます。
			</p>
			{token ? (
				<SecretReveal value={token} note="このトークンは今だけ表示します。" />
			) : me.user.personalTokenHint ? (
				<p className="font-mono text-xs">{me.user.personalTokenHint}</p>
			) : (
				<p className="text-sm text-[var(--text-muted)]">
					まだ発行していません。
				</p>
			)}
		</Section>
	);
}

function CliTokens() {
	const toast = useToast();
	const tokens = useData<CliTokenJson[]>("/cli-tokens");
	const [label, setLabel] = useState("");
	const [token, setToken] = useState<string | null>(null);
	const create = async (event: FormEvent) => {
		event.preventDefault();
		try {
			const result = await api<{ token: string }>("/cli-tokens", {
				method: "POST",
				body: { label },
			});
			setToken(result.token);
			setLabel("");
			await tokens.reload();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};
	const remove = async (item: CliTokenJson) => {
		if (!window.confirm(`${item.label ?? "この CLI トークン"} を消しますか？`))
			return;
		try {
			await api(`/cli-tokens/${item.id}`, { method: "DELETE" });
			await tokens.reload();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), "error");
		}
	};
	return (
		<Section title="CLI トークン">
			<Form
				onSubmit={create}
				className="mb-4 flex flex-wrap items-end gap-3 space-y-0"
			>
				<div className="min-w-48 flex-1">
					<Field label="名前">
						{(id) => (
							<Input
								id={id}
								value={label}
								onChange={(event) => setLabel(event.target.value)}
								placeholder="ノート PC"
							/>
						)}
					</Field>
				</div>
				<Button type="submit" size="md">
					発行
				</Button>
			</Form>
			{token && (
				<div className="mb-4">
					<SecretReveal
						value={token}
						note="このトークンは今だけ表示します。「pnpm cli login」で入れてください。"
					/>
				</div>
			)}
			{!tokens.data ? (
				<Skeleton className="h-12 w-full" />
			) : tokens.data.length === 0 ? (
				<p className="text-sm text-[var(--text-muted)]">
					CLI トークンはありません。
				</p>
			) : (
				<ul className="divide-y divide-[var(--border)]">
					{tokens.data.map((item) => (
						<li
							key={item.id}
							className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm"
						>
							<div>
								<p>{item.label ?? "(名前なし)"}</p>
								<p className="text-xs text-[var(--text-muted)]">
									{formatDateTime(item.createdAt)} に発行
									{item.lastUsedAt !== null &&
										`、最後に使ったのは ${formatDateTime(item.lastUsedAt)}`}
								</p>
							</div>
							<Button
								variant="destructive"
								size="sm"
								onClick={() => void remove(item)}
							>
								消す
							</Button>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}

function ClientSetup() {
	const { me } = useMe();
	const key = "sgk_….sgu_…";
	const base = (id: string) =>
		`${me.origin}${me.providers.find((provider) => provider.id === id)?.clientBasePath ?? ""}`;
	return (
		<Section title="クライアントの設定">
			<div className="space-y-5 text-sm">
				<div>
					<h3 className="mb-2 font-medium">base URL</h3>
					<ul className="space-y-1">
						{me.providers.map((provider) => (
							<li key={provider.id} className="flex flex-wrap gap-x-3">
								<span className="w-24 text-[var(--text-secondary)]">
									{provider.label}
								</span>
								<code className="text-xs">{base(provider.id)}</code>
							</li>
						))}
					</ul>
				</div>
				<div>
					<h3 className="mb-2 font-medium">Claude Code</h3>
					<CodeBlock
						code={`export ANTHROPIC_BASE_URL=${base("anthropic")}\nexport ANTHROPIC_API_KEY=${key}`}
					/>
				</div>
				<div>
					<h3 className="mb-2 font-medium">OpenAI の SDK</h3>
					<CodeBlock
						code={`export OPENAI_BASE_URL=${base("openai")}\nexport OPENAI_API_KEY=${key}`}
					/>
				</div>
				<div>
					<h3 className="mb-2 font-medium">curl</h3>
					<CodeBlock
						code={`curl ${base("openai")}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"hi"}]}'`}
					/>
				</div>
			</div>
		</Section>
	);
}

export function SettingsPage() {
	return (
		<>
			<PageHeader title="設定" />
			<PersonalToken />
			<CliTokens />
			<ClientSetup />
		</>
	);
}
