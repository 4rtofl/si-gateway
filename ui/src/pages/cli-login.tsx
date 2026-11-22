import type { CliLoginJson } from "@api/types.ts";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "../app/api.ts";
import { useMe } from "../app/me.tsx";

type State =
	| { kind: "loading" }
	| { kind: "ready"; login: CliLoginJson }
	| { kind: "approved" }
	| { kind: "denied" }
	| { kind: "error"; message: string };

/** sigw auth login で開く画面。ターミナルと同じコードかを確かめて、CLI のログインを許可する */
export function CliLoginPage() {
	const { me } = useMe();
	const code = new URLSearchParams(window.location.search).get("code") ?? "";
	const [state, setState] = useState<State>({ kind: "loading" });
	const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

	useEffect(() => {
		if (!code) {
			setState({
				kind: "error",
				message: "コードがありません。ターミナルに出た URL を開いてください。",
			});
			return;
		}
		api<CliLoginJson>(`/cli-login/${encodeURIComponent(code)}`)
			.then((login) =>
				setState(
					login.status === "pending"
						? { kind: "ready", login }
						: {
								kind: "error",
								message: "このコードはもう使われています。",
							},
				),
			)
			.catch((error: unknown) =>
				setState({
					kind: "error",
					message: error instanceof ApiError ? error.message : String(error),
				}),
			);
	}, [code]);

	async function decide(approve: boolean) {
		setBusy(approve ? "approve" : "deny");
		try {
			await api(
				`/cli-login/${encodeURIComponent(code)}/${approve ? "approve" : "deny"}`,
				{ method: "POST" },
			);
			setState({ kind: approve ? "approved" : "denied" });
		} catch (error) {
			setState({
				kind: "error",
				message: error instanceof ApiError ? error.message : String(error),
			});
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="grid min-h-dvh place-items-center px-4">
			<div className="w-full max-w-sm space-y-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
				<h1 className="text-xl font-semibold">CLI のログイン</h1>
				{state.kind === "loading" && (
					<p className="text-sm text-[var(--text-secondary)]">読み込み中…</p>
				)}
				{state.kind === "ready" && (
					<>
						<p className="text-sm text-[var(--text-secondary)]">
							{state.login.clientName} の sigw CLI が、{me.user.name}{" "}
							としてログインしようとしています。ターミナルに出ているコードと同じなら、許可してください。
						</p>
						<p className="text-center font-mono text-3xl font-semibold tracking-widest">
							{state.login.userCode}
						</p>
						<div className="grid grid-cols-2 gap-3">
							<Button
								variant="secondary"
								onClick={() => void decide(false)}
								isLoading={busy === "deny"}
								disabled={busy !== null}
							>
								拒否
							</Button>
							<Button
								onClick={() => void decide(true)}
								isLoading={busy === "approve"}
								disabled={busy !== null}
							>
								許可
							</Button>
						</div>
					</>
				)}
				{state.kind === "approved" && (
					<Alert tone="success">
						<AlertDescription>
							ログインしました。ターミナルに戻ってください。
						</AlertDescription>
					</Alert>
				)}
				{state.kind === "denied" && (
					<Alert tone="neutral">
						<AlertDescription>拒否しました。</AlertDescription>
					</Alert>
				)}
				{state.kind === "error" && (
					<Alert tone="danger">
						<AlertDescription>{state.message}</AlertDescription>
					</Alert>
				)}
			</div>
		</div>
	);
}
