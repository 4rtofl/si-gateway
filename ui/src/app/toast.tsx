import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";
import { VelocityToast } from "@/components/ui/velocity-toast";

type Kind = "success" | "error";

const ToastContext = createContext<(title: string, kind?: Kind) => void>(
	() => {},
);

/** 画面の右下に短い知らせを出す */
export function useToast() {
	return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toast, setToast] = useState<{
		title: string;
		kind: Kind;
		key: number;
	} | null>(null);
	const show = useCallback((title: string, kind: Kind = "success") => {
		setToast({ title, kind, key: Date.now() });
	}, []);
	return (
		<ToastContext.Provider value={show}>
			{children}
			<VelocityToast
				key={toast?.key}
				open={toast !== null}
				title={toast?.title ?? ""}
				variant={toast?.kind ?? "success"}
				position="bottom-right"
				duration={toast?.kind === "error" ? 8000 : 3000}
				onDismiss={() => setToast(null)}
			/>
		</ToastContext.Provider>
	);
}
