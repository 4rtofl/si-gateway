import { ChevronLeft, ChevronRight } from "lucide-react";
import { monthLabel, shiftMonth } from "@/app/format";
import { Button } from "@/components/ui/button";

export function MonthNav({
	month,
	onChange,
	max,
}: {
	month: string;
	onChange: (month: string) => void;
	max?: string;
}) {
	return (
		<div className="flex items-center gap-1">
			<Button
				variant="ghost"
				size="icon"
				aria-label="前の月"
				onClick={() => onChange(shiftMonth(month, -1))}
			>
				<ChevronLeft className="h-4 w-4" />
			</Button>
			<span className="min-w-24 text-center text-sm tabular-nums">
				{monthLabel(month)}
			</span>
			<Button
				variant="ghost"
				size="icon"
				aria-label="次の月"
				disabled={max !== undefined && month >= max}
				onClick={() => onChange(shiftMonth(month, 1))}
			>
				<ChevronRight className="h-4 w-4" />
			</Button>
		</div>
	);
}
