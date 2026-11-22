-- Anthropic の Managed Agents のセッション。料金はセッションの中で発生し、中継した応答には出てこないので、
-- POST /v1/sessions を中継したときに記録しておき、Cron で GET /v1/sessions/{id} の usage(累計)を読む。
-- 前回読んだ累計を持っておき、増えた分を usage_events に書く(docs/design.md 5.3)
CREATE TABLE agent_sessions (
	-- Anthropic のセッション ID(sesn_…)
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	sigw_key_id TEXT NOT NULL,
	provider_key_id TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	-- session.agent.model.id。単価はこのモデルで計算する
	model TEXT,
	-- セッションを作ったときにクライアントが送った anthropic-beta。Cron で読むときも同じ値を送る
	anthropic_beta TEXT,
	-- セッションを作ったリクエストの入口(usage_events.via と同じ)。'bobert' なら BobertGateway からの代理の呼び出し。
	-- Cron で書く使用量の行にも、この値を入れる
	via TEXT,
	created_at INTEGER NOT NULL,
	-- 前回読んだ usage の累計
	input_tokens INTEGER NOT NULL DEFAULT 0,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	active_seconds REAL NOT NULL DEFAULT 0,
	-- 累計を書き換えるたびに、新しい乱数にする。Cron と DELETE の中継が同時に読んでも、二重に記録しないため
	revision TEXT,
	-- 前回読んだときの status(running、idle、rescheduling、terminated)
	status TEXT,
	last_polled_at INTEGER,
	-- このセッションへのリクエスト(イベントの送信など)を最後に中継した時刻
	touched_at INTEGER,
	-- 読むのをやめた時刻と理由(terminated、deleted、not_found)。NULL なら Cron で読む
	ended_at INTEGER,
	end_reason TEXT
);
CREATE INDEX agent_sessions_open ON agent_sessions (last_polled_at) WHERE ended_at IS NULL;
