import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyButton({
	value,
	label = "コピー",
}: {
	value: string;
	label?: string;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="secondary"
			size="sm"
			leftIcon={
				copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />
			}
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		>
			{copied ? "コピーしました" : label}
		</Button>
	);
}

/** 発行したトークンを一度だけ見せる */
export function SecretReveal({ value, note }: { value: string; note: string }) {
	return (
		<div className="space-y-2 rounded-lg border border-dashed border-[var(--border-hover)] bg-[var(--surface-raised)] p-3">
			<p className="text-xs text-amber-300">{note}</p>
			<div className="flex flex-wrap items-center gap-2">
				<code className="min-w-0 flex-1 break-all text-xs">{value}</code>
				<CopyButton value={value} />
			</div>
		</div>
	);
}

export function CodeBlock({ code }: { code: string }) {
	return (
		<div className="relative">
			<pre className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 pr-24 text-xs leading-relaxed">
				{code}
			</pre>
			<div className="absolute top-2 right-2">
				<CopyButton value={code} />
			</div>
		</div>
	);
}
