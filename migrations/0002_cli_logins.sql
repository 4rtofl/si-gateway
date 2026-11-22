-- CLI のブラウザでのログイン(sigw auth login)。CLI が始めて、Web UI で本人が許可すると、CLI トークンを渡す
CREATE TABLE cli_logins (
	id TEXT PRIMARY KEY,
	-- CLI だけが知っているコードのハッシュ。CLI はこのコードで結果を問い合わせる
	device_code_hash TEXT NOT NULL UNIQUE,
	-- 画面とターミナルに出す確認用のコード(ABCD-EFGH)
	user_code TEXT NOT NULL UNIQUE,
	-- CLI を動かしている端末の名前(ホスト名)
	client_name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
	user_id TEXT REFERENCES users (id),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
