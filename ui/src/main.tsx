import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { MeProvider } from "./app/me.tsx";
import { Shell } from "./app/shell.tsx";
import { ToastProvider } from "./app/toast.tsx";
import { CliLoginPage } from "./pages/cli-login.tsx";
import { DashboardPage } from "./pages/dashboard.tsx";
import { KeyDetailPage } from "./pages/key-detail.tsx";
import { KeysPage } from "./pages/keys.tsx";
import { LoginPage } from "./pages/login.tsx";
import { PricesPage } from "./pages/prices.tsx";
import { SettingsPage } from "./pages/settings.tsx";
import { SettlementsPage } from "./pages/settlements.tsx";
import { UsagePage } from "./pages/usage.tsx";

function Loading() {
	return (
		<div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
			<Skeleton className="h-7 w-48" />
			<Skeleton className="h-32 w-full" />
			<Skeleton className="h-64 w-full" />
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<BrowserRouter>
				<ToastProvider>
					<Routes>
						<Route path="/login" element={<LoginPage />} />
						<Route
							path="/cli/login"
							element={
								<MeProvider fallback={<Loading />}>
									<CliLoginPage />
								</MeProvider>
							}
						/>
						<Route
							element={
								<MeProvider fallback={<Loading />}>
									<Shell />
								</MeProvider>
							}
						>
							<Route index element={<DashboardPage />} />
							<Route path="keys" element={<KeysPage />} />
							<Route path="keys/:id" element={<KeyDetailPage />} />
							<Route path="usage" element={<UsagePage />} />
							<Route path="settlements" element={<SettlementsPage />} />
							<Route path="prices" element={<PricesPage />} />
							<Route path="settings" element={<SettingsPage />} />
						</Route>
					</Routes>
				</ToastProvider>
			</BrowserRouter>
		</StrictMode>,
	);
}
