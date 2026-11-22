import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function LoginPage() {
	const params = new URLSearchParams(window.location.search);
	const error = params.get("error");
	const next = params.get("next");
	const loginUrl = next
		? `/auth/login?next=${encodeURIComponent(next)}`
		: "/auth/login";
	return (
		<div className="grid min-h-dvh place-items-center px-4">
			<div className="w-full max-w-sm space-y-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
				<h1 className="text-xl font-semibold">sigw</h1>
				{error && (
					<Alert tone="danger">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				<Button fullWidth onClick={() => window.location.assign(loginUrl)}>
					Discord でログイン
				</Button>
			</div>
		</div>
	);
}
