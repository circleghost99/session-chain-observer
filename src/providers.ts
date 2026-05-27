import { claudeCodeProvider } from "./claude-code-provider.js";
import { openClawProvider } from "./openclaw-provider.js";
import type { ProviderId, ProviderOptions, SessionMeta, SessionProvider } from "./model.js";

const providers: Record<ProviderId, SessionProvider> = {
  openclaw: openClawProvider,
  "claude-code": claudeCodeProvider,
};

export function getProvider(provider: ProviderId = "openclaw"): SessionProvider {
  return providers[provider] ?? openClawProvider;
}

export async function resolveSession(
  keyOrId: string,
  provider?: ProviderId,
  opts: ProviderOptions = {},
): Promise<{ provider: SessionProvider; meta: SessionMeta } | null> {
  if (provider) {
    const p = getProvider(provider);
    const meta = await p.resolveSession(keyOrId, opts);
    return meta ? { provider: p, meta } : null;
  }

  for (const p of [openClawProvider, claudeCodeProvider]) {
    const meta = await p.resolveSession(keyOrId, opts);
    if (meta) return { provider: p, meta };
  }
  return null;
}

export async function listSessions(
  provider: ProviderId,
  agentId: string | undefined,
  opts: ProviderOptions & { hoursBack?: number; limit?: number } = {},
): Promise<SessionMeta[]> {
  return getProvider(provider).listSessions(agentId, opts);
}
