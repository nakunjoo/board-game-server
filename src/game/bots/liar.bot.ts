import { GameContext } from '../game.context';
import { LiarHandler } from '../games/liar/liar.handler';
import { LIAR_TOPICS } from '../games/liar/liar.words';
import { BotSelf, BotBrain, botScheduler } from './bot.brain';
import { LlmCall } from './llm';

/** 서버 liar.handler.ts와 같은 비교 (자기 단어가 든 말은 서버가 막으므로 미리 거른다) */
const normalize = (s: string) =>
  s.replace(/[\s\p{P}\p{S}ㄱ-ㆎ]/gu, '').toLowerCase();

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/** LLM이 없거나 늦을 때 쓰는 문장 */
const FALLBACK_DESC = [
  '주변에서 흔히 볼 수 있어요',
  '좋아하는 사람이 많아요',
  '한 번쯤은 경험해 봤을 거예요',
  '생각보다 자주 접해요',
  '사람마다 취향이 갈려요',
  '어릴 때부터 알던 거예요',
];
const FALLBACK_CHAT = [
  '흠 다들 비슷한데',
  '누가 좀 애매했어',
  '나는 아니야',
  '설명 하나가 좀 수상해',
  '음…',
];
const FALLBACK_DEFEND = [
  '나 아니야 진짜',
  '내 설명 괜찮았잖아',
  '왜 나야?',
  '난 맞게 설명했어',
];

const RULES = [
  "너는 한국 친구들과 하는 파티 게임 '라이어'의 참가자다.",
  '모두 같은 주제와 제시어를 받는데, 딱 한 명(라이어)만 같은 주제의 비슷한 다른 단어를 받는다.',
  '라이어도 자기가 라이어인 줄 모른다. 너도 네가 라이어일 수 있다.',
  '차례대로 제시어를 한 줄로 설명하고, 그다음 토론해서 라이어를 투표로 찾는다.',
].join('\n');

/** 한 줄로 다듬기: 첫 줄, 따옴표·앞 번호·끝 마침표 제거, 길면 단어 사이에서 자른다 */
function oneLine(text: string, max: number): string {
  let line = (text.split('\n').find((l) => l.trim()) ?? '')
    .replace(/^["'“”‘’\-\s\d.)]+|["'“”‘’\s.]+$/g, '')
    .trim();
  if (line.length > max) {
    const cut = line.slice(0, max);
    const space = cut.lastIndexOf(' ');
    line = (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
  }
  return line;
}

/** 정답 시도는 단어 하나만: "게(또는 크랩)" → "게" */
function oneWord(text: string): string {
  return oneLine(text, 40)
    .replace(/\(.*?\)|（.*?）/g, '')
    .split(/[\s,/·]|또는|혹은/)[0]
    .trim();
}

/** 설명 길이 (실제로 써 보니 길게 쓰면 정답이 다 보였다: "붉은빛 털과 긴 꼬리의 포식자") */
const DESC_MAX = 24;

/**
 * 라이어 봇.
 * 사람과 같은 정보(주제, 내 단어, 지금까지의 설명·채팅)만 쓴다. 누가 라이어인지, 다른 단어가 뭔지는 보지 않는다.
 * 말은 LLM으로 만들고, 없거나 늦거나 이상하면(빈 답, 자기 단어 포함) 미리 써 둔 문장으로 대신한다
 */
export function createLiarBot(
  ctx: GameContext,
  liar: LiarHandler,
  self: BotSelf,
  llm: LlmCall,
): BotBrain {
  const { later, room } = botScheduler(ctx, self);
  const sock = self.sock;
  const roomName = self.roomName;
  /** 이번 판에 이미 변명했는지 (판마다 한 번만 — 비용과 도배 방지) */
  let defended = -1;
  const chatLog: { name: string; text: string }[] = [];

  /** 지금 판에서 봇이 아는 것 */
  const view = () => {
    const r = room();
    const s = r?.liar;
    if (!r || !s) return null;
    const myWord = self.id === s.liarId ? s.liarWord : s.word;
    const myName = s.nicknames.get(self.id) ?? '';
    const descs = s.descriptions
      .filter((d) => !d.skipped)
      .map(
        (d) =>
          `- ${s.nicknames.get(d.playerId) ?? '?'}${d.playerId === self.id ? '(나)' : ''}: ${d.text}`,
      );
    return { r, s, myWord, myName, descs };
  };

  const safe = (text: string | null, myWord: string, max: number) => {
    if (!text) return null;
    const line = oneLine(text, max);
    if (!line || normalize(line).includes(normalize(myWord))) return null;
    return line;
  };

  const describe = async () => {
    const v = view();
    if (!v) return;
    const { s, myWord, descs } = v;
    const lap = Math.floor(s.speakIndex / Math.max(1, s.speakOrder.length)) + 1;
    const answer = await llm({
      system: `${RULES}\n지금은 네 설명 차례다. 너무 자세하면 라이어가 정답을 눈치채고, 너무 애매하면 라이어로 의심받는다.\n특징을 딱 하나만 짧게 말해라. 생김새·색·크기·사는 곳을 한꺼번에 늘어놓지 말 것. 같은 걸 아는 사람은 고개를 끄덕이지만 모르는 사람은 바로 떠올리기 어려운 정도.\n앞사람들이 이미 말한 특징은 되풀이하지 말 것.\n앞사람들 설명이 네 단어와 잘 안 맞으면 네가 라이어일 수 있으니, 남들 설명과도 어울리게 두루뭉술하게 말해라.\n출력: 설명 한 줄만. 10~20자. 반말이나 해요체 아무거나. 제시어나 그 글자를 쓰지 말 것. 따옴표·이모지·마침표 없이.`,
      user: `주제: ${s.topic}\n내 제시어: ${myWord}\n${lap}바퀴째\n지금까지 나온 설명:\n${descs.join('\n') || '(아직 없음)'}\n\n내 설명:`,
      timeoutMs: 12000,
    });
    const text = safe(answer, myWord, DESC_MAX) ?? pick(FALLBACK_DESC);
    // LLM을 기다리는 동안 차례가 넘어갔으면(시간 초과·나감) 보내지 않는다
    const now = room()?.liar;
    if (!now || now !== s || now.phase !== 'describe') return;
    if (now.speakOrder[now.speakIndex % now.speakOrder.length] !== self.id)
      return;
    liar.handleText({ roomName, text }, sock);
  };

  const say = async (kind: 'chat' | 'defend') => {
    const v = view();
    if (!v || v.s.phase !== 'discuss') return;
    const { s, myWord, myName, descs } = v;
    const answer = await llm({
      // 실제로 돌려 보니 봇 이름(🤖봇2)의 이모지 때문에 "봇2 좀 이상한데"처럼 자기를 의심했다 → 이름을 못 박아 둔다
      system: `${RULES}\n너의 이름은 "${myName}"이다. 설명 목록에서 "(나)"가 붙은 줄이 네 설명이다. 너 자신을 의심하거나 3인칭으로 부르지 말 것.\n지금은 토론 시간이다. 친구들끼리 채팅하듯 짧게 반말로 한 마디 해라.${
        kind === 'defend'
          ? ' 방금 누가 너를 의심했다. 너무 방어적이지 않게 해명해라.'
          : ' 수상한 사람이 있으면 다른 사람 이름을 짚어도 좋다.'
      }\n출력: 채팅 한 줄만. 25자 이내. 네 제시어나 그 글자를 쓰지 말 것.`,
      user: `주제: ${s.topic}\n내 이름: ${myName}\n내 제시어: ${myWord}\n설명:\n${descs.join('\n')}\n최근 채팅:\n${
        chatLog
          .slice(-8)
          .map((c) => `- ${c.name}: ${c.text}`)
          .join('\n') || '(없음)'
      }\n\n내 채팅:`,
    });
    const text =
      safe(answer, myWord, 60) ??
      pick(kind === 'defend' ? FALLBACK_DEFEND : FALLBACK_CHAT);
    if (room()?.liar?.phase === 'discuss')
      liar.handleText({ roomName, text }, sock);
  };

  const vote = async () => {
    const v = view();
    if (!v || v.s.phase !== 'discuss' || v.s.votes.has(self.id)) return;
    const { r, s, myWord, descs } = v;
    const inRoom = new Set(r.playerIds.values());
    const candidates = s.speakOrder.filter(
      (id) => id !== self.id && inRoom.has(id),
    );
    if (candidates.length === 0) return;
    const names = candidates.map((id) => s.nicknames.get(id) ?? id);
    const answer = await llm({
      system: `${RULES}\n이제 투표한다. 설명들을 보고 제시어가 다른 것 같은 사람(라이어)을 골라라. 네 단어와 안 맞는 설명이 많다면 네가 라이어일 수도 있지만, 투표는 남에게만 할 수 있다.\n출력: 후보 이름 하나만 그대로.`,
      user: `주제: ${s.topic}\n내 제시어: ${myWord}\n설명:\n${descs.join('\n')}\n후보: ${names.join(', ')}\n\n투표할 이름:`,
    });
    const now = room()?.liar;
    if (!now || now !== s || now.phase !== 'discuss') return;
    const chosen = answer ? names.findIndex((n) => answer.includes(n)) : -1;
    const targetId = chosen !== -1 ? candidates[chosen] : pick(candidates);
    liar.handleVote({ roomName, targetId }, sock);
  };

  const guess = async () => {
    const v = view();
    if (!v || v.s.phase !== 'liarGuess' || v.s.accusedId !== self.id) return;
    const { s, myWord, descs } = v;
    const answer = await llm({
      system: `${RULES}\n너는 라이어로 지목됐고, 실제로 네 단어는 다른 사람들 단어와 달랐다. 다른 사람들 설명을 보고 그들의 제시어를 맞혀라.\n출력: 단어 하나만.`,
      user: `주제: ${s.topic}\n내가 받은 (틀린) 단어: ${myWord}\n설명:\n${descs.join('\n')}\n\n다른 사람들의 제시어:`,
      timeoutMs: 12000,
    });
    // 없으면 같은 주제의 다른 단어 중 하나로 찍는다
    const fallback = () => {
      const group = LIAR_TOPICS.find((t) => t.topic === s.topic)?.groups.find(
        (g) => g.includes(myWord),
      );
      return pick((group ?? [myWord]).filter((w) => w !== myWord)) ?? myWord;
    };
    const text = (answer ? oneWord(answer) : '') || fallback();
    if (room()?.liar?.phase === 'liarGuess')
      liar.handleText({ roomName, text }, sock);
  };

  const run = (fn: () => Promise<void>) => () => {
    void fn().catch((e) => console.error(`[LiarBot] ${self.id}`, e));
  };

  return (event: string, data: unknown) => {
    const d = (data ?? {}) as Record<string, unknown>;
    const s = room()?.liar;
    switch (event) {
      case 'liarRound':
        chatLog.length = 0;
        break;
      case 'liarSpeakTurn':
        if (d.speakerId === self.id)
          later('describe', run(describe), 1500 + Math.random() * 2000);
        break;
      case 'liarDiscuss':
        // 토론 때 한 마디는 봇마다 60% 확률로 한 번 (판마다)
        if (s && Math.random() < 0.6)
          later(
            'chat',
            run(() => say('chat')),
            3000 + Math.random() * 9000,
          );
        // 사람들이 이야기할 시간을 두고 투표
        later('vote', run(vote), 12000 + Math.random() * 18000);
        break;
      case 'liarChat': {
        const name = typeof d.nickname === 'string' ? d.nickname : '';
        const text = typeof d.text === 'string' ? d.text : '';
        if (d.playerId === self.id || !text) break;
        chatLog.push({ name, text });
        const myName = s?.nicknames.get(self.id);
        // 누가 나를 콕 집으면 판마다 한 번 해명
        if (
          s &&
          s.phase === 'discuss' &&
          myName &&
          text.includes(myName) &&
          defended !== s.round
        ) {
          defended = s.round;
          later(
            'defend',
            run(() => say('defend')),
            2000 + Math.random() * 3000,
          );
        }
        break;
      }
      case 'liarVoteUpdate': {
        // 사람이 모두 투표했으면 봇도 곧 투표 (기다리게 하지 않는다)
        const r = room();
        if (!r || !s || s.votes.has(self.id)) break;
        const humans = s.speakOrder.filter(
          (id) =>
            !id.startsWith('bot:') && [...r.playerIds.values()].includes(id),
        );
        if (humans.length > 0 && humans.every((id) => s.votes.has(id)))
          later('vote', run(vote), 1500 + Math.random() * 2500, true);
        break;
      }
      case 'liarGuessTime':
        if (d.liarId === self.id) later('guess', run(guess), 2000);
        break;
    }
  };
}
