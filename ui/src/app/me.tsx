import type { MeJson } from "@api/types.ts";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { api } from "./api.ts";

interface MeState {
	me: MeJson;
	reload: () => Promise<void>;
	nameOf: (id: string | null | undefined) => string;
}

const MeContext = createContext<MeState | null>(null);

export function useMe(): MeState {
	const state = useContext(MeContext);
	if (!state) throw new Error("useMe は MeProvider の中で使ってください");
	return state;
}

export function MeProvider({
	children,
	fallback,
}: {
	children: ReactNode;
	fallback: ReactNode;
}) {
	const [me, setMe] = useState<MeJson | null>(null);
	const reload = useCallback(async () => {
		setMe(await api<MeJson>("/me"));
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);
	const nameOf = useCallback(
		(id: string | null | undefined) => {
			if (!id) return "—";
			return me?.members.find((member) => member.id === id)?.name ?? id;
		},
		[me],
	);
	if (!me) return fallback;
	return (
		<MeContext.Provider value={{ me, reload, nameOf }}>
			{children}
		</MeContext.Provider>
	);
}
