import { type ReactNode, useId } from "react";
import { FormDescription, FormItem, FormLabel } from "@/components/ui/form";

/** ラベル付きの入力欄。children に id を渡す */
export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: (id: string) => ReactNode;
}) {
	const id = useId();
	return (
		<FormItem>
			<FormLabel htmlFor={id}>{label}</FormLabel>
			{children(id)}
			{hint && <FormDescription>{hint}</FormDescription>}
		</FormItem>
	);
}
