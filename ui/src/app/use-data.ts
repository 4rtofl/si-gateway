import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";

/** API から読み、読み直す関数と一緒に返す */
export function useData<T>(path: string | null) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const reload = useCallback(async () => {
		if (path === null) return;
		setLoading(true);
		try {
			setData(await api<T>(path));
			setError(null);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setLoading(false);
		}
	}, [path]);
	useEffect(() => {
		void reload();
	}, [reload]);
	return { data, error, loading, reload };
}
