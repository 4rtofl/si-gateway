-- 1つの sigw キーに、プロバイダごとに1つずつプロバイダキーを結び付ける。docs/design.md「3.2 sigw キーの設定」
-- 今までの sigw_keys.provider_key_id は、新しい表 sigw_key_providers に1行ずつ移し、列は消す。
-- usage_events と agent_sessions は、呼び出しごとに provider_key_id と owner_id を持っているので、手を入れない。
--
-- SQLite の ALTER TABLE DROP COLUMN は、外部キーと索引のある列を消せないので、sigw_keys を作り直す。
-- sigw_keys を参照する外部キーは、まだどの表にもない(usage_events.sigw_key_id などは外部キーではない)。
-- そのため、先に sigw_keys を作り直してから、sigw_keys を参照する sigw_key_providers を作る。
-- 結び付きは、作り直す前に、外部キーのない作業用の表に写しておく。

-- 1. 今の結び付きを写しておく(sigw キー1つにつき1行)
CREATE TABLE sigw_key_providers_move (
	sigw_key_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	provider_key_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
INSERT INTO sigw_key_providers_move (sigw_key_id, provider, provider_key_id, created_at)
SELECT s.id, p.provider, s.provider_key_id, s.created_at
FROM sigw_keys s JOIN provider_keys p ON p.id = s.provider_key_id;

-- 2. provider_key_id のない sigw_keys を作り、ほかの列をそのまま移す
CREATE TABLE sigw_keys_new (
	id TEXT PRIMARY KEY,
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
INSERT INTO sigw_keys_new (id, created_by, purpose, token_hash, token_hint, allowed_models,
	monthly_limit_nano_usd, expires_at, created_at, updated_at, revoked_at)
SELECT id, created_by, purpose, token_hash, token_hint, allowed_models,
	monthly_limit_nano_usd, expires_at, created_at, updated_at, revoked_at
FROM sigw_keys;

-- 索引 sigw_keys_provider_key も、表と一緒に消える
DROP TABLE sigw_keys;
ALTER TABLE sigw_keys_new RENAME TO sigw_keys;

-- 3. sigw キーとプロバイダキーの結び付き。プロバイダごとに1つまで。
-- provider は provider_keys.provider と同じ値。主キーで「プロバイダごとに1つ」を守るために持つ
CREATE TABLE sigw_key_providers (
	sigw_key_id TEXT NOT NULL REFERENCES sigw_keys (id),
	provider TEXT NOT NULL,
	provider_key_id TEXT NOT NULL REFERENCES provider_keys (id),
	-- 結び付けた時刻
	created_at INTEGER NOT NULL,
	PRIMARY KEY (sigw_key_id, provider)
);
CREATE INDEX sigw_key_providers_provider_key ON sigw_key_providers (provider_key_id);

INSERT INTO sigw_key_providers (sigw_key_id, provider, provider_key_id, created_at)
SELECT sigw_key_id, provider, provider_key_id, created_at FROM sigw_key_providers_move;
DROP TABLE sigw_key_providers_move;
