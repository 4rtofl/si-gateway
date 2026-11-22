-- Bobert からの代理の呼び出し(Service Binding の BobertGateway)。docs/design.md「4.5 Bobert からの代理の呼び出し」

-- 代理専用のプロバイダキー。1 なら、これにつながる sigw キーは公開の入口(sgk_….sgu_…)では使えず、
-- BobertGateway からだけ使える
ALTER TABLE provider_keys ADD COLUMN delegated_only INTEGER NOT NULL DEFAULT 0;

-- 呼び出しが届いた入口。'bobert' なら BobertGateway からの代理の呼び出し、NULL なら公開の入口
ALTER TABLE usage_events ADD COLUMN via TEXT;
