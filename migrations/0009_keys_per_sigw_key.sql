-- API キー(プロバイダキー)を、sigw キーごとに登録する形にする。docs/design.md「3.2 sigw キーの設定」「3.3 キーの削除」
-- 表は変えない。今までの provider_keys と sigw_key_providers をそのまま使い、
-- これからは、プロバイダキー1つを1つの sigw キーだけに結び付ける(sigw キーに API キーを登録するたびに、新しい行を作る)。
-- ここでは、どの sigw キーにも結び付いていないプロバイダキーを、0008 と同じ形で削除する。
-- 今までの画面の「プロバイダキー」の一覧はなくなるので、結び付いていないキーは、もう見ることも使うこともできないため。
--
-- 1. 削除した sigw キーの結び付きを消す。sigw キーを削除するときは、これからは結び付きも消すので、それに合わせる
DELETE FROM sigw_key_providers
WHERE sigw_key_id IN (SELECT id FROM sigw_keys WHERE deleted_at IS NOT NULL);

-- 2. 結び付きのない、削除していないプロバイダキーを削除する。無効にし、deleted_at に今の時刻(UNIX ミリ秒)を入れる。
--    暗号化したキーは空の文字列にする。ただし、Managed Agents のセッションが動いている(読むのをやめていない)キーは残す。
--    Cron がこのキーでセッションの使用量を読み、セッションが終わってから消す(5.3)
-- 2つ以上の sigw キーに結び付いたプロバイダキーは、そのまま残し、どの sigw キーからも今までどおり使える。
-- そのキーは、どれか1つの sigw キーで差し替えたり外したりしても、ほかの sigw キーに結び付いているあいだは削除しない
UPDATE provider_keys SET
	deleted_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
	disabled_at = COALESCE(disabled_at, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
	encrypted_key = CASE
		WHEN EXISTS (
			SELECT 1 FROM agent_sessions a WHERE a.provider_key_id = provider_keys.id AND a.ended_at IS NULL
		) THEN encrypted_key
		ELSE ''
	END
WHERE deleted_at IS NULL
	AND NOT EXISTS (SELECT 1 FROM sigw_key_providers l WHERE l.provider_key_id = provider_keys.id);
