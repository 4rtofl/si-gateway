-- プロバイダキーと sigw キーの削除。docs/design.md「3.3 キーの削除」
-- 削除しても行は残す(過去の使用量に名前を出すため)。秘密の値だけを消し、deleted_at に削除した時刻を入れる。
-- - プロバイダキー: encrypted_key を空の文字列にする(列は NOT NULL なので、NULL にはしない)
-- - sigw キー: token_hash を「deleted:」と ID をつないだ値にする(列は NOT NULL かつ UNIQUE なので、NULL や空にはしない)。
--   SHA-256 の16進の文字列にはならないので、どのトークンとも一致しない
-- どちらも列を足すだけなので、表は作り直さない
ALTER TABLE provider_keys ADD COLUMN deleted_at INTEGER;
ALTER TABLE sigw_keys ADD COLUMN deleted_at INTEGER;
