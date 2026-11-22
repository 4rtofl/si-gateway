-- TypeSafe の Jev の単価。TypeSafe は LiteLLM の価格表にないので、手で決めた単価(source = 'manual')として入れる。
-- 2026-11-04 時点で、入力は100万トークンあたり $0.042、出力は無料。
-- 応答の model は jev-1.14.0 のように版の番号が付くが、単価表では版を外した jev で引く(src/pricing/cost.ts)。
-- provider の列には CHECK がないので、表を作り直す必要はない。すでに単価を決めてあれば、そのまま残す
INSERT OR IGNORE INTO model_prices (provider, model, source, price, updated_at)
VALUES ('typesafe', 'jev', 'manual', '{"input":4.2e-8,"output":0}', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
