import {
	CreditCard,
	Gauge,
	KeyRound,
	LogOut,
	Receipt,
	Settings,
	Tags,
} from "lucide-react";
import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
	Sidebar,
	type SidebarSection,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar";
import { useMe } from "./me.tsx";

const SECTIONS: SidebarSection[] = [
	{
		items: [
			{ id: "/", label: "ダッシュボード", icon: <Gauge /> },
			{ id: "/keys", label: "キー", icon: <KeyRound /> },
			{ id: "/usage", label: "使用量", icon: <CreditCard /> },
			{ id: "/settlements", label: "精算", icon: <Receipt /> },
			{ id: "/prices", label: "価格", icon: <Tags /> },
			{ id: "/settings", label: "設定", icon: <Settings /> },
		],
	},
];

function activeId(pathname: string): string {
	const first = `/${pathname.split("/")[1] ?? ""}`;
	return SECTIONS[0]?.items.some((item) => item.id === first) ? first : "/";
}

function Brand() {
	const { collapsed } = useSidebar();
	return (
		<div className="px-2.5 py-1 text-sm font-semibold">
			{collapsed ? "s" : "sigw"}
		</div>
	);
}

function Account() {
	const { me } = useMe();
	const { collapsed } = useSidebar();
	return (
		<form
			method="post"
			action="/auth/logout"
			className="flex items-center gap-2 px-1"
		>
			{me.user.avatar ? (
				<img
					src={`https://cdn.discordapp.com/avatars/${me.user.id}/${me.user.avatar}.png?size=64`}
					alt=""
					className="size-7 shrink-0 rounded-full"
				/>
			) : (
				<div className="size-7 shrink-0 rounded-full bg-[var(--surface-raised)]" />
			)}
			{!collapsed && (
				<span className="min-w-0 flex-1 truncate text-sm">{me.user.name}</span>
			)}
			<button
				type="submit"
				aria-label="ログアウト"
				title="ログアウト"
				className="grid size-8 shrink-0 place-items-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
			>
				<LogOut className="size-4" />
			</button>
		</form>
	);
}

export function Shell() {
	const location = useLocation();
	const navigate = useNavigate();
	const [mobileOpen, setMobileOpen] = useState(false);
	return (
		<div className="flex min-h-dvh md:h-dvh">
			<Sidebar
				sections={SECTIONS}
				activeId={activeId(location.pathname)}
				onActiveChange={(id) => navigate(id)}
				header={<Brand />}
				footer={<Account />}
				mobileOpen={mobileOpen}
				onMobileOpenChange={setMobileOpen}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-4 md:hidden">
					<SidebarTrigger onClick={() => setMobileOpen(true)} />
					<span className="text-sm font-semibold">sigw</span>
				</div>
				<main className="min-w-0 flex-1 md:overflow-y-auto">
					<div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
						<Outlet />
					</div>
				</main>
			</div>
		</div>
	);
}
