# sigw

Org の3人で LLM のクレジットを分け合うためのゲートウェイです。誰かが OpenAI・Anthropic・xAI・OpenRouter で買ったキーを sigw に登録すると、ほかのメンバーも sigw を通してそのキーを使えます。sigw は呼び出しごとに「誰が、何の目的で、誰のキーを使ったか」を記録し、毎月1日に、使った分を [Daichoo](https://github.com/4rtofl/Daichoo) の台帳に書き込みます。支払いの一覧は、Daichoo がいつもどおり Discord に送ります。

設計の詳細は [docs/design.md](docs/design.md) にあります。

## 使い方

### 1. 個人トークンを発行する

Web UI に Discord でログインし、「設定」で個人トークン(`sgu_…`)を発行します。トークンは発行したときに一度だけ表示されます。なくしたら発行し直してください。

### 2. キーを用意する

- **クレジットを買った人**: 「キー」でプロバイダキーを登録します。登録したキーは、末尾4文字しか表示されません
- **使う人**: 「キー」で、目的ごとに sigw キー(`sgk_…`)を発行します。使えるモデル、月の上限額(3人の合計)、有効期限を決められます。sigw キーは3人とも使えます

### 3. クライアントに設定する

API キーには、sigw キーと個人トークンを `.` でつないだ文字列を入れます。

```sh
# Claude Code
export ANTHROPIC_BASE_URL=https://sigw.4rna-y.workers.dev/anthropic
export ANTHROPIC_API_KEY=sgk_xxxx.sgu_yyyy

# OpenAI の SDK
export OPENAI_BASE_URL=https://sigw.4rna-y.workers.dev/openai/v1
export OPENAI_API_KEY=sgk_xxxx.sgu_yyyy
```

| プロバイダ | base URL                                            |
| ---------- | --------------------------------------------------- |
| OpenAI     | `https://sigw.4rna-y.workers.dev/openai/v1`         |
| Anthropic  | `https://sigw.4rna-y.workers.dev/anthropic`         |
| xAI        | `https://sigw.4rna-y.workers.dev/xai/v1`            |
| OpenRouter | `https://sigw.4rna-y.workers.dev/openrouter/api/v1` |

- 各プロバイダの API をそのまま中継するので、SDK もプロバイダ固有の機能も、そのまま使えます
- バッチ API と Realtime API は、使用量を記録できないので使えません

### 4. 精算

毎月1日の0時5分(日本時間)に、前の月の分を「使った人 → キーの持ち主」ごとに合計し、円にして Daichoo の台帳(`ledger/YYYY-MM.tsv`)に書き込みます。自分のキーを自分で使った分は請求しません。為替レートは、そのときの USD/JPY を取得し、台帳の memo に残します。

- 「精算」で、前の月のプレビューを見たり、為替レートを手で決めたり、手で精算したりできます
- 料金が不明な呼び出し(単価表にないモデル)は精算に入りません。「価格」で単価を足すと、料金を計算し直します

### CLI

Web UI の「設定」で CLI トークン(`sgc_…`)を発行して使います。

```sh
pnpm cli login https://sigw.4rna-y.workers.dev
pnpm cli keys
pnpm cli usage --by model
pnpm cli settle preview
pnpm cli --help
```

## デプロイ

用意するもの:

- Cloudflare のアカウント(Workers Paid)と D1 のデータベース `sigw`(`pnpm exec wrangler d1 create sigw --location apac`)
- sigw 専用の Discord アプリ。OAuth2 の Redirects に `https://sigw.4rna-y.workers.dev/auth/callback` と `http://localhost:8787/auth/callback` を入れる
- Daichoo の台帳にコミットする GitHub App の秘密鍵(Daichoo の App をそのまま使う)
- プロバイダキーを暗号化する鍵(`openssl rand -base64 32`)。なくすと、登録したプロバイダキーを読めなくなる

手順:

1. `pnpm install`
2. `wrangler.jsonc` の `vars`(`DISCORD_CLIENT_ID`、`ALLOWED_DISCORD_IDS` など)と、D1 の `database_id` を確かめる
3. `.dev.vars.example` を `.dev.vars` にコピーして、シークレットを入れる
4. 初めてのときは `pnpm exec wrangler deploy` で Worker を作ってから、`pnpm exec wrangler secret bulk .dev.vars` でシークレットを入れる
5. `pnpm run deploy`(UI のビルド、D1 のマイグレーション、デプロイ)
6. Web UI の「価格」で「LiteLLM から同期」を押す(以後は毎日0時5分に自動で同期する)

## 開発

```sh
pnpm install
pnpm migrate:local   # 手元の D1 にスキーマを作る
pnpm build && pnpm dev   # http://localhost:8787
pnpm dev:ui          # UI だけを Vite で動かす(http://localhost:5173。API は :8787 に渡す)
pnpm test
pnpm lint
pnpm typecheck
```

- `src/`: Worker(中継、JSON API、ログイン、Cron)
- `ui/`: Web UI(React、Vite、[easyui](https://easyui.site))
- `cli/`: CLI(Node.js 24 でビルドせずに動く)
- `migrations/`: D1 のスキーマ
- 偽のプロバイダで中継を試すときは、`wrangler dev --var 'UPSTREAM_OVERRIDE:{"openai":"http://127.0.0.1:9999"}'` のように転送先を差し替える
- `src/github/` は Daichoo(MPL-2.0)から、`ui/src/components/ui/` などは easyui(MIT)から持ってきたもの
