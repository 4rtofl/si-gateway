# sigw 設計書

sigw は、Org のメンバー3人で LLM のクレジットを分け合うためのゲートウェイです。誰か1人がプロバイダ(OpenAI、Anthropic、xAI、OpenRouter、TypeSafe)でクレジットを買い、そのキーを sigw に登録します。ほかのメンバーは sigw を通してそのキーで LLM を呼び出します。sigw は呼び出しごとに「誰が、何の目的で、誰のキーを使ったか」を記録し、毎月1日に、使った分を [Daichoo](https://github.com/4rtofl/Daichoo) の台帳に書き込みます。支払いの一覧は Daichoo がいつもどおり Discord に送ります。

## 1. 前提と方針

| 項目       | 決めたこと                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------- |
| メンバー   | 3人で固定。Discord のユーザー ID で識別し、Daichoo の台帳と同じ ID を使う                           |
| 動かす場所 | Cloudflare Workers(Paid プラン)。言語は TypeScript。DB は D1                                        |
| 最優先     | ストリーミングの速さ。応答の最初のバイトが届くまでの経路に、余計な待ちを入れない                    |
| API の形   | 各プロバイダの API をそのまま中継する。クライアントは base URL とキーを変えるだけ                   |
| 料金       | 応答に実費があれば使う(OpenRouter など)。なければ、トークン数 × 単価表                              |
| 精算       | 毎月1日 0:05(日本時間)に、前月分を「利用者 → キーの所有者」ごとに1行で Daichoo の台帳にコミットする |
| 為替       | 精算のときに USD/JPY を取得する。使ったレートは台帳の memo に残す                                   |
| 管理       | Web UI(Discord でログイン)と CLI。使用量は3人全員が全員分を見られる                                 |

## 2. 全体の構成

```
クライアント(SDK、Claude Code など)           Bobert(Discord の bot の Worker)
   │  Authorization: Bearer sgk_….sgu_…          │  Service Binding(entrypoint: BobertGateway)
   ▼                                              ▼  x-api-key: sgk_…、x-sigw-user: Discord ID
Cloudflare Worker「sigw」(Web UI・API は portal.sigw.4rtofl.org、中継は si.sigw.4rtofl.org、
                         CLI のインストールスクリプトは cli.sigw.4rtofl.org)
   ├─ /openai/*  /anthropic/*  /xai/*  /openrouter/*  /typesafe/*   … 中継(src/proxy/)
   ├─ /api/*                                                        … Web UI と CLI が使う JSON API(src/api/)
   ├─ /auth/*                                                       … Discord OAuth(src/web/auth.ts)
   ├─ それ以外                                                      … Web UI(ui/ をビルドしたもの。Static Assets が返す)
   ├─ D1「sigw」                                                    … キー、使用量、価格表、精算の記録
   ├─ Cron(毎日)                                                   … 価格表の同期、毎月1日の精算
   └─ Cron(5分ごと)                                                … Managed Agents のセッションの使用量を読む
          │
          ├─ Anthropic の GET /v1/sessions/{id}
          ├─ LiteLLM の価格表(GitHub の raw)
          ├─ 為替 API(Frankfurter、予備に open.er-api.com)
          └─ GitHub App として 4rtofl/Daichoo の ledger/YYYY-MM.tsv にコミット
```

## 3. キーの種類

sigw には4種類のキーと資格情報があります。

| 名前           | 形              | 何に使うか                                       | 誰が持つか                               |
| -------------- | --------------- | ------------------------------------------------ | ---------------------------------------- |
| プロバイダキー | `sk-…` など     | プロバイダの本物のキー。sigw の中だけで使う      | 購入者が登録する。登録後は誰にも見えない |
| sigw キー      | `sgk_` + 32文字 | 「どのプロバイダキーを、何の目的で使うか」を表す | 利用者が自分で発行する。3人全員が使える  |
| 個人トークン   | `sgu_` + 32文字 | 「誰が使ったか」を表す                           | 1人1つ。Web UI で再発行できる            |
| CLI トークン   | `sgc_` + 32文字 | CLI から管理 API を使う                          | 1人がいくつでも発行できる                |

### 3.1 呼び出しのときの認証

クライアントは、sigw キーと個人トークンを `.` でつないだ文字列を API キーとして使います。

```
sgk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.sgu_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
└──────── 目的(sigw キー) ────────┘ └──────── 誰か(個人トークン) ────────┘
```

- `Authorization: Bearer …` と `x-api-key: …` のどちらでも受け付ける。Anthropic の SDK は `x-api-key` を、OpenAI の SDK は `Authorization` を使うため
- sigw キーだけ、または個人トークンだけでは呼び出せない。必ず利用者が決まる
- DB にはどちらもハッシュ(SHA-256)だけを保存する。発行したときに一度だけ画面に出す
- Bobert からの代理の呼び出しだけは、個人トークンを使わない(4.5)

### 3.2 sigw キーの設定

| 設定            | 中身                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| プロバイダキー  | 中継に使うプロバイダキー(1つ)。発行後は変えられない                    |
| 目的            | 自由な名前(例「記事要約バッチ」)                                       |
| 使えるモデル    | 空なら制限なし。`*` を使ったパターンを並べられる(例 `claude-sonnet-*`) |
| 月の上限額(USD) | 3人の合計。日本時間の月ごとに数える。空なら上限なし                    |
| 有効期限        | この時刻を過ぎると使えない。空なら期限なし                             |

- 発行は誰でもできる。設定の変更と無効化は、発行した人とプロバイダキーの所有者ができる
- プロバイダキーを無効にすると、それに紐づく sigw キーもすべて使えなくなる

## 4. 中継(ストリーミングを速くするために)

### 4.1 経路

| パス            | 転送先                        | プロバイダキーの渡し方  |
| --------------- | ----------------------------- | ----------------------- |
| `/openai/*`     | `https://api.openai.com/*`    | `Authorization: Bearer` |
| `/anthropic/*`  | `https://api.anthropic.com/*` | `x-api-key`             |
| `/xai/*`        | `https://api.x.ai/*`          | `Authorization: Bearer` |
| `/openrouter/*` | `https://openrouter.ai/*`     | `Authorization: Bearer` |
| `/typesafe/*`   | `https://api.typesafe.ai/*`   | `Authorization: Bearer` |

例: OpenAI の SDK は `base_url = https://si.sigw.4rtofl.org/openai/v1`、Claude Code は `ANTHROPIC_BASE_URL=https://si.sigw.4rtofl.org/anthropic`。

中継のパスは、どのドメインでも受け付けます。`si.sigw.4rtofl.org`(`PROXY_HOST`)では中継だけを受け付け、画面・API・ログインのパスは 404 にします。このため、Static Assets よりも先に、すべてのリクエストを Worker が受けます(`assets.run_worker_first: true`)。

### 4.2 1回の呼び出しの流れ

1. ヘッダーから sigw キーと個人トークンを取り出し、それぞれのハッシュを計算する
2. sigw キーの設定、プロバイダキー(復号済み)、個人トークンの持ち主、今月の使用額を、**isolate のメモリのキャッシュ**から引く。なければ D1 から読む(読み取りはレプリカで足りるので、D1 の Sessions API で最寄りから読む)
3. 有効期限、上限額、モデルの制限を確かめる。だめならプロバイダと同じ形のエラーを返す(OpenAI・xAI・OpenRouter は `{"error": {"message", "type", "code"}}`、Anthropic は `{"type": "error", "error": {"type", "message"}}`、TypeSafe は `{"detail": "…"}`)
4. リクエストを転送する。本文に手を入れるのは次の場合だけ
   - OpenAI・xAI の `/chat/completions` で `stream: true` のとき、`stream_options.include_usage = true` を足す(最後のチャンクで使用量を受け取るため)
   - OpenRouter では `usage.include = true` を足す(使用量と実費を受け取るため)
5. 応答の本文を `tee()` で2つに分け、片方を**そのまま**クライアントに返す。もう片方は `ctx.waitUntil` の中で読み、使用量を取り出して D1 に書く

応答を返すまでに待つのは、キャッシュがないときの D1 の読み取り1回(並列)と、プロバイダの応答だけです。使用量の解析と書き込みは、クライアントへの転送と並んで進み、転送を遅らせません。

### 4.3 キャッシュと、その影響

| キャッシュ                      | 有効な時間 | 影響                                                                                                              |
| ------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| sigw キーとプロバイダキーの設定 | 30秒       | 無効化や設定の変更が、ほかの isolate に届くまで最大30秒かかる                                                     |
| 個人トークン                    | 30秒       | 再発行した古いトークンが、最大30秒使える                                                                          |
| 今月の使用額                    | 30秒       | 同じ isolate の中では、呼び出しのたびに使用額を足していく。上限額は、最大でおよそ30秒分の使用だけ超えることがある |

30秒を過ぎた値は、手元の値で応答しながら裏で D1 から読み直します(stale-while-revalidate)。10分を過ぎた値は使わず、読み直すのを待ちます。見つからなかった結果は5秒だけ覚えておくので、発行したばかりのキーはすぐに使えます。

上限額をきっちり守るより、応答を待たせないことを優先しています。

### 4.4 応答の扱い

- `Content-Encoding` と `Content-Length` は外して返す(fetch が展開した本文を返すため)
- クライアントが途中で切断しても、`tee()` のもう片方は読み続けるので、多くの場合は最後の使用量まで受け取れる。受け取れなかったときは、届いた分だけを記録し、`incomplete` の印を付ける
- バッチ API(`/v1/batches`、`/v1/messages/batches`)は、使用量を呼び出しのときに受け取れないので、403 で断る

### 4.5 Bobert からの代理の呼び出し

[Bobert](https://github.com/4rtofl/Bobert)(同じ Cloudflare アカウントの Discord の bot)は、利用者のプロバイダキーを持たず、LLM の呼び出しをすべて sigw に通します。Bobert は3人の代わりに呼び出すので、「誰が使ったか」は個人トークンではなく、Bobert から受け取ります。

入口は、名前付きのエントリポイント `BobertGateway`(`WorkerEntrypoint`、`src/index.ts`)です。名前付きのエントリポイントは公開のドメインからは届かないので、Service Binding でしか呼べません。Bobert の `wrangler.jsonc` には、次の設定を入れます。

```jsonc
"services": [{ "binding": "SIGW", "service": "sigw", "entrypoint": "BobertGateway" }]
```

Bobert は `env.SIGW.fetch(url, init)` で呼びます。パスは公開の入口と同じです(例 `https://sigw/anthropic/v1/messages`)。ホストは見ません。

| ヘッダー                               | 中身                                           |
| -------------------------------------- | ---------------------------------------------- |
| `x-api-key` か `Authorization: Bearer` | sigw キー(`sgk_…`)だけ。個人トークンは付けない |
| `x-sigw-user`                          | 呼び出しを頼んだ利用者の Discord ID            |

- 名乗れるのは `users` にいる人だけ。いなければ、プロバイダと同じ形の 401 を返す
- `x-sigw-user` はプロバイダに転送しない。公開の入口では、このヘッダーを無視する(利用者は個人トークンで決める)
- それ以外の確かめ方(有効期限、上限額、モデルの制限)と記録は、公開の入口と同じ。`usage_events.via` に `bobert` を入れ、Web UI と CLI の呼び出しの一覧で「Bobert」の印を出す

#### 代理専用のプロバイダキー

プロバイダキーは、登録するときに「代理専用」にできます(`provider_keys.delegated_only`)。代理専用のプロバイダキーにつながる sigw キーは、公開の入口(`sgk_….sgu_…`)では 403 で断り、`BobertGateway` からだけ使えます。登録したあとは変えられません。

代理専用にする理由は、Bobert の Managed Agents が、利用者ごとの Vault(GitHub のトークン)をそのワークスペースに置くためです。同じワークスペースのキーを公開の入口から使えると、メンバーがほかの人の Vault を付けたセッションを作れてしまいます。そのため、Anthropic では、キーの持ち主が Bobert 専用のワークスペースを作り、そこで発行したキーを代理専用として登録します。

## 5. 使用量と料金

### 5.1 使用量の取り出し

使用量は、次の形にそろえて記録します。

| 項目                                           | 中身                                                    |
| ---------------------------------------------- | ------------------------------------------------------- |
| `input_tokens`                                 | キャッシュを使わなかった入力                            |
| `cache_read_tokens`                            | キャッシュから読んだ入力                                |
| `cache_write_tokens` / `cache_write_1h_tokens` | キャッシュに書いた入力(Anthropic の5分と1時間)          |
| `output_tokens`                                | 出力(推論のトークンを含む)                              |
| `cost_nano_usd`                                | 料金(10⁻⁹ USD 単位の整数)                               |
| `cost_source`                                  | `provider`(応答の実費)、`pricing`(単価表)、`null`(不明) |

| プロバイダ                                | 取り出し方                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI(Chat Completions、Embeddings など) | `usage.prompt_tokens` から `prompt_tokens_details.cached_tokens` を引いたものを入力にする。ストリーミングは最後のチャンクの `usage` |
| OpenAI(Responses)                         | `response.completed` などのイベントの `response.usage`                                                                              |
| Anthropic                                 | `message_start` の `usage` と、`message_delta` の `usage`(累計)を合わせる                                                           |
| xAI                                       | OpenAI と同じ。`total_tokens` が入力と出力の和より大きければ、差を出力に足す(推論のトークン)                                        |
| OpenRouter                                | OpenAI と同じ形。`usage.cost`(USD)を実費として使う                                                                                  |
| TypeSafe                                  | 応答の JSON の `usage.input_tokens` と `usage.output_tokens`(Bobert が使う `POST /v1/systemone` は、ストリーミングしない)           |

### 5.2 単価表

- 毎日 0:05(日本時間)に、[LiteLLM の価格表](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)から4つのプロバイダ(OpenAI、Anthropic、xAI、OpenRouter)の分を D1 の `model_prices` に取り込む
- TypeSafe は LiteLLM の価格表にないので、取り込まない。単価は手で決める。マイグレーション `0005` で、Jev(`jev`)の単価を手で決めた単価として入れてある(2026-11-04 時点で、入力は100万トークンあたり $0.042、出力は無料)
- Web UI と CLI で、モデルごとの単価を手で決められる。手で決めた単価は、同期で上書きしない
- モデル名は「完全一致 → 日付を外した名前 → 版の番号や `-latest` を外した名前」の順で探す(例: `jev-1.14.0` と `jev-latest` は `jev` で引く)
- 入力が20万トークンを超えたときの単価、1時間キャッシュの単価、OpenAI の `service_tier`(flex・priority)の単価が表にあれば使う
- 単価が見つからない呼び出しは、料金を空のまま記録する。単価を足したあと、毎日の Cron(と精算の直前)で料金を計算し直す

### 5.3 Managed Agents のセッション

Anthropic の Managed Agents(`/v1/agents`、`/v1/sessions` など)も、ほかの API と同じように中継します。ただし料金はセッションの中で発生し、中継した応答(セッションの作成やイベントの送信)には出てきません。そこで sigw は、セッションの usage(累計)をあとから読み、前回読んだ累計から増えた分を `usage_events` に書きます。

1. `POST /v1/sessions` の中継が成功したら、応答のセッション ID を `agent_sessions` に記録する。利用者、sigw キー、プロバイダキー、所有者、モデル(`agent.model.id`)、クライアントが送った `anthropic-beta`、入口(`via`)も一緒に残し、累計は0から始める。Bobert からの代理の呼び出し(4.5)で作ったセッションも、同じように記録する
2. 5分ごとの Cron で、読む必要のあるセッションを `GET /v1/sessions/{id}` で読む。プロバイダキーはセッションを作ったときのもので、無効にしたキーも使う
3. 累計から前回との差を出し、`usage_events` に2行まで足す。利用者と所有者、入口(`via`)は、セッションを作ったときの値にする
   - トークンの行: `input_tokens`、`cache_read_input_tokens`、`cache_creation`(5分と1時間)、`output_tokens` の差を、セッションのモデルの単価で計算する。単価がなければ、ほかの呼び出しと同じく料金を空にして、あとで計算し直す
   - 実行時間の行: `usage.active_seconds` の差 × 1時間あたり $0.08。model は `managed-agents-runtime` にする
4. `DELETE /v1/sessions/{id}` を中継する前に、最後の分を読んで記録する(method は `DELETE` で残す)。削除を遅らせないよう、待つのは3秒までにする。3秒を過ぎたら削除を中継し、読み終わるのを裏で待つ

Cron で読むのは、次のどれかに当たるセッションです。1回に100件まで、前回読んだのが古い順に読みます。

- まだ一度も読んでいない、または状態が `idle` 以外(`running`、`rescheduling`)
- そのセッションへのリクエスト(イベントの送信など)を、最後に中継してから15分以内
- 前回読んでから6時間たった(sigw を通さずに動かされたときのため)

次のときは、読むのをやめます。

- 状態が `terminated` になった(最後の分を記録してからやめる)
- `GET` が 404 を返した
- `DELETE` の中継が成功した(か、404 だった)

Cron と `DELETE` の中継が同時に同じセッションを読んでも、二重には記録しません。`agent_sessions` の `revision` を、累計を書き換えるたびに新しい乱数にします。`usage_events` の行は「読んだときの `revision` を書き換えられたとき」だけ、同じトランザクションで足します。

`anthropic-beta` は、クライアントが送らなかったときは `managed-agents-2026-04-01`(`@anthropic-ai/sdk` 1.1.0 が付ける値)を送ります。

## 6. 精算

1. 毎月1日 0:05(日本時間)の Cron で、前月分の精算を始める。0:05 に失敗しても、3:05 と 6:05 にやり直す。Daichoo の精算は 9:17
2. 前月の使用量を「利用者 × プロバイダキーの所有者」ごとに合計する。利用者と所有者が同じ行(自分のキーを自分で使った分)は除く
3. 為替 API から USD/JPY を取得する。Web UI で、その月のレートを手で決めておくこともできる
4. 合計(USD)× レートを、偶数丸めで円の整数にする。0円になった組は書かない
5. GitHub App として、Daichoo の `ledger/YYYY-MM.tsv`(精算する月のファイル)に1行ずつ足す。同じ ID の行がすでにあれば足さない
6. 精算した結果を D1 の `settlements` に保存する

台帳に書く行の例です。

| 列                          | 値                                       |
| --------------------------- | ---------------------------------------- |
| `id`                        | `sigw-2026-11-<所有者のID>-<利用者のID>` |
| `recorded_at`               | 書き込んだ時刻(日本時間)                 |
| `payer_id` / `payer_name`   | プロバイダキーの所有者                   |
| `debtor_id` / `debtor_name` | 使った人                                 |
| `amount`                    | 円                                       |
| `split`                     | 1(列があるときだけ書く)                  |
| `memo`                      | `LLM 2026-11 $12.345678 @154.32 (sigw)`  |

- 台帳に書いたあとで内訳を確かめたいときは、Web UI の「精算」で、その月の内訳(sigw キー、モデルごと)を見られる
- Web UI と CLI から、精算のプレビューと、手での実行ができる

## 7. Web UI

`ui/` にある React の SPA です。部品は [easyui](https://easyui.site)(MIT)を shadcn CLI で `ui/src/components/ui/` に取り込んで使います。easyui の Form は暗い配色で作られているので、画面はダークテーマだけにしています。ビルドしたもの(`ui/dist`)は、Worker が `env.ASSETS` を通して返します。

Discord の OAuth2(scope は `identify`)でログインします。`ALLOWED_DISCORD_IDS` にある3人だけが入れます。

| ページ              | 中身                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| ダッシュボード `/`  | 今月の使用額(利用者 × 所有者)、sigw キーごとの使用額と上限、最近の呼び出し |
| キー `/keys`        | プロバイダキーの登録と無効化、sigw キーの発行・変更・無効化                |
| 使用量 `/usage`     | 月を選んで、利用者・所有者・sigw キー・モデルごとの内訳と、呼び出しの一覧  |
| 精算 `/settlements` | 月ごとの精算のプレビュー、為替レートの指定、実行、過去の結果               |
| 価格 `/prices`      | 単価表の検索、手での単価の指定、同期の実行                                 |
| 設定 `/settings`    | 個人トークンと CLI トークン、クライアントの設定例                          |

- 画面は `/api/*` を Cookie のセッションで呼ぶ。GET 以外は、`Origin` が同じサイトのときだけ受け付ける(CSRF 対策)
- セッションの Cookie は `HttpOnly; Secure; SameSite=Lax`(手元の http://localhost では Secure を付けない)
- easyui から取り込んだ部品は、画面の文言を日本語にしたことと、StatCard で比べる前の値が0のときに増減を出さないようにしたこと以外は、そのまま使う
- セッションの有効期限は30日

## 8. CLI

`cli/sigw.ts` を、Bun(`bun build --compile`)で OS ごとのネイティブのバイナリにして配ります。開発中は Node.js 24 で直接動かせます(`pnpm cli`)。CLI トークンで `/api/*` を呼びます。

### 配り方

- `cli-v0.1.0` の形のタグを push すると、`.github/workflows/release-cli.yml` が7種類のバイナリ(Linux の x64・arm64 と、それぞれの musl 版、macOS の x64・arm64、Windows の x64)と `SHA256SUMS` を GitHub Releases に置く。macOS 用は、アドホック署名を付けるため macOS で作る
- cli.sigw.4rtofl.org(vars の `CLI_HOST`)は、`/install.sh`、`/install.ps1`、`/latest`(最新の版)だけを返す(`src/web/cli-dist.ts`)。最新の版は、GitHub の API の回数制限を避けるため `/releases/latest` のリダイレクト先から読み、5分キャッシュする
- インストールスクリプトは OS と CPU を見てバイナリを選び、`SHA256SUMS` と照らしてから `~/.local/bin/sigw`(Windows は `%LOCALAPPDATA%\sigw\bin\sigw.exe`)に置く
- `sigw update` も同じ手順で自分を置き換える

```sh
curl -fsSL https://cli.sigw.4rtofl.org/install.sh | sh
sigw auth login
```

### ブラウザでのログイン(`sigw auth login`)

OAuth 2.0 のデバイス認可(RFC 8628)と同じ流れです。手元のポートで待ち受けないので、SSH の先でも使えます。

1. CLI が `POST /api/cli-login/start`(ログイン不要)を呼び、device code(CLI だけが持つ)と確認用のコード(`ABCD-EFGH`)を受け取る
2. CLI がブラウザで `/cli/login?code=ABCD-EFGH` を開く。Web UI にログインしていなければ Discord でログインし、この画面に戻る
3. 本人が、ターミナルと同じコードかを確かめて「許可」を押す(`POST /api/cli-login/:code/approve`)
4. CLI は2秒ごとに `POST /api/cli-login/poll`(ログイン不要)で問い合わせ、許可されていれば CLI トークンを受け取る。トークンは1回しか渡さない

- 期限は10分。期限内の手続きが20件を超えたら、新しく始めさせない(誰でも呼べる API なので)
- 許可・拒否は Cookie のセッションでだけ受け付け、ほかの書き込みと同じく別のサイトからは受け付けない
- ブラウザがない環境では、Web UI の「設定」で発行した CLI トークンを `sigw auth login --with-token` で入れられる
- `sigw auth logout` は、手元の設定と一緒に、サーバーの CLI トークンも消す

```sh
sigw keys
sigw keys create --provider-key <id> --purpose "記事要約" --limit 20 --models "gpt-5*"
sigw usage --month 2026-11 --by model
sigw settle preview 2026-11
```

## 9. データベース(D1)

| テーブル         | 中身                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `users`          | Discord の ID、表示名、個人トークンのハッシュ                                                                   |
| `sessions`       | Web UI のセッションと CLI トークン(どちらもハッシュ)                                                            |
| `cli_logins`     | CLI のブラウザでのログインの途中の状態(device code のハッシュ、確認用のコード)                                  |
| `provider_keys`  | プロバイダ、所有者、暗号化したキー(AES-GCM)、末尾4文字、代理専用かどうか                                        |
| `sigw_keys`      | プロバイダキー、目的、トークンのハッシュ、制限、無効化した時刻                                                  |
| `usage_events`   | 呼び出し1回が1行。利用者、sigw キー、所有者、モデル、トークン数、料金、状態、所要時間、入口(`via`)              |
| `agent_sessions` | Managed Agents のセッション。作った利用者と sigw キー、入口(`via`)、前回読んだ usage の累計、読むのをやめた時刻 |
| `model_prices`   | プロバイダとモデルごとの単価。出所(`litellm` か `manual`)                                                       |
| `settlements`    | 精算した月、レート、台帳に書いた行                                                                              |
| `fx_overrides`   | 月ごとに手で決めた為替レート                                                                                    |

スキーマは `migrations/` にあります。

## 10. 安全のための決めごと

- プロバイダキーは、Worker のシークレット `KEY_ENCRYPTION_SECRET` で AES-GCM で暗号化して保存する。API と Web UI は、末尾4文字しか返さない
- トークンはハッシュだけを保存する。いずれも 190 ビット程度の乱数なので、ソルトなしの SHA-256 で足りる
- 中継の転送先は、手元での確認のときだけ `UPSTREAM_OVERRIDE`(JSON)で差し替えられる。本番では設定しない
- 中継するとき、クライアントの `Authorization`、`x-api-key`、`x-sigw-user`、`Cookie`、Cloudflare が足したヘッダーは転送しない
- Bobert が利用者を名乗れるのは、Service Binding の `BobertGateway` だけ。代理専用のプロバイダキーは、公開の入口では使えない(4.5)

## 11. 割り切っていること

- 上限額は最大30秒分ほど超えることがある(4.3)
- 料金は単価表をもとにした見積もりで、プロバイダの請求と1円単位では一致しない。Web 検索などのツールの料金、画像や音声の秒単位の料金は、単価表にない限り数えない
- Realtime API(WebSocket)とバッチ API は中継しない
- Managed Agents のセッションの料金は、最大5分ほど遅れて記録される。その間は上限額の判定にも入らない。トークンの料金は、セッションの `agent.model` の単価だけで計算する。サブエージェントや advisor が別のモデルを使っても、その単価では数えない。累計の差は多くの呼び出しの合計なので、20万トークンを超えたときの単価は使わない
