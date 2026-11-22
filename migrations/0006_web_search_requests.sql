-- サーバー側の Web 検索の回数(Anthropic の usage.server_tool_use.web_search_requests)。料金を計算し直すときに使う
ALTER TABLE usage_events ADD COLUMN web_search_requests INTEGER NOT NULL DEFAULT 0;
