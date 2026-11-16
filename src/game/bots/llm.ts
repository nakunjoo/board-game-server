/**
 * 봇이 말해야 하는 게임(라이어 등)에서 쓰는 OpenAI 호출. tarot-saju(lib/ai/client.ts)처럼 SDK 없이 fetch로.
 *
 * 환경 변수 (VM ~/.env.production):
 *   OPENAI_API_KEY      — 없으면 호출하지 않고 null (봇은 미리 써 둔 문장으로 대신한다)
 *   BOT_LLM_MODEL       — 기본 gpt-5-mini
 *   BOT_LLM_DAILY_LIMIT — 하루 최대 호출 수 (기본 3000). 넘으면 null — 장난이나 버그로 비용이 새지 않게
 *
 * 실패·시간 초과(기본 8초)도 모두 null. 게임은 절대 LLM을 기다리다 멈추지 않는다
 */
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

let day = '';
let used = 0;

function underDailyLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    used = 0;
  }
  const limit = Number(process.env.BOT_LLM_DAILY_LIMIT ?? 3000);
  if (used >= limit) return false;
  used++;
  return true;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** 짧은 답만 필요하므로 작게 */
  maxTokens?: number;
  timeoutMs?: number;
}

export type LlmCall = (req: LlmRequest) => Promise<string | null>;

export const callLlm: LlmCall = async ({
  system,
  user,
  maxTokens = 300,
  timeoutMs = 8000,
}) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !underDailyLimit()) return null;
  const model = process.env.BOT_LLM_MODEL ?? 'gpt-5-mini';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        // gpt-5·o 계열은 답 전에 생각하는 단계가 있다. 한 줄짜리 답이라 가장 짧게
        ...(/^(gpt-5|o\d)/.test(model)
          ? { reasoning_effort: 'minimal', max_completion_tokens: maxTokens }
          : { max_tokens: maxTokens }),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.error(
        `[BotLLM] ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? text : null;
  } catch (e) {
    if ((e as Error).name !== 'AbortError')
      console.error('[BotLLM] 호출 실패', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
};
