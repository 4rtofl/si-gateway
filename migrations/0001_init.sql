-- sigw のスキーマ。時刻はすべて UNIX ミリ秒、金額は 10^-9 USD 単位の整数(nano USD)

-- Org のメンバー。id は Discord のユーザー ID
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	avatar TEXT,
	personal_token_hash TEXT UNIQUE,
	personal_token_hint TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- Web UI のセッション(kind = 'web')と CLI トークン(kind = 'cli')
CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	user_id TEXT NOT NULL REFERENCES users (id),
	kind TEXT NOT NULL CHECK (kind IN ('web', 'cli')),
	label TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER,
	last_used_at INTEGER
);
CREATE INDEX sessions_user ON sessions (user_id, kind);

-- プロバイダのキー。encrypted_key は AES-GCM で暗号化したもの(iv + 暗号文 を base64)
CREATE TABLE provider_keys (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL REFERENCES users (id),
	provider TEXT NOT NULL,
	label TEXT NOT NULL,
	encrypted_key TEXT NOT NULL,
	key_hint TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	disabled_at INTEGER
);

-- 目的ごとに発行する sigw キー
CREATE TABLE sigw_keys (
	id TEXT PRIMARY KEY,
	provider_key_id TEXT NOT NULL REFERENCES provider_keys (id),
	created_by TEXT NOT NULL REFERENCES users (id),
	purpose TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	token_hint TEXT NOT NULL,
	-- JSON の文字列の配列。NULL なら制限なし
	allowed_models TEXT,
	monthly_limit_nano_usd INTEGER,
	expires_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	revoked_at INTEGER
);
CREATE INDEX sigw_keys_provider_key ON sigw_keys (provider_key_id);

-- 中継した呼び出し1回が1行
CREATE TABLE usage_events (
	id TEXT PRIMARY KEY,
	-- 日本時間の月(2026-11)
	month TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	user_id TEXT NOT NULL,
	sigw_key_id TEXT NOT NULL,
	provider_key_id TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	method TEXT NOT NULL,
	path TEXT NOT NULL,
	model TEXT,
	stream INTEGER NOT NULL DEFAULT 0,
	status INTEGER NOT NULL,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	service_tier TEXT,
	-- NULL なら料金が不明(単価表にない)。単価を足したあとで計算し直す
	cost_nano_usd INTEGER,
	cost_source TEXT,
	incomplete INTEGER NOT NULL DEFAULT 0,
	ttfb_ms INTEGER,
	duration_ms INTEGER,
	upstream_request_id TEXT,
	error TEXT
);
CREATE INDEX usage_events_month ON usage_events (month, created_at);
CREATE INDEX usage_events_key_month ON usage_events (sigw_key_id, month);
CREATE INDEX usage_events_unpriced ON usage_events (cost_nano_usd) WHERE cost_nano_usd IS NULL;

-- モデルごとの単価(USD / トークン)。source = 'litellm' は同期で上書きし、'manual' は残す
CREATE TABLE model_prices (
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('litellm', 'manual')),
	-- 単価の JSON(src/pricing/types.ts の Price)
	price TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (provider, model)
);

-- 月ごとに手で決めた為替レート(1 USD あたりの円)
CREATE TABLE fx_overrides (
	month TEXT PRIMARY KEY,
	usd_jpy REAL NOT NULL,
	set_by TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

-- 精算した結果。lines は台帳に書いた行の JSON
CREATE TABLE settlements (
	month TEXT PRIMARY KEY,
	usd_jpy REAL NOT NULL,
	fx_source TEXT NOT NULL,
	lines TEXT NOT NULL,
	ledger_url TEXT,
	settled_at INTEGER NOT NULL,
	settled_by TEXT NOT NULL
);
