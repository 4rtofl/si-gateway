/** 文字列の配列を、その区切りでチャンクにした ReadableStream にする */
export function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

/** SSE のイベントの並びを作る */
export function sse(events: unknown[], done = false): string {
	return (
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
		(done ? "data: [DONE]\n\n" : "")
	);
}
