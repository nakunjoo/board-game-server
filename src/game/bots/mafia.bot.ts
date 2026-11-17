import { GameContext } from '../game.context';
import { MafiaRole } from '../game.types';
import { MafiaHandler } from '../games/mafia/mafia.handler';
import { BotSelf, BotBrain, botScheduler } from './bot.brain';
import { LlmCall } from './llm';

const pick = <T>(a: T[]): T | undefined =>
  a[Math.floor(Math.random() * a.length)];

const ROLE_NAME: Record<MafiaRole, string> = {
  mafia: '마피아',
  police: '경찰',
  doctor: '의사',
  citizen: '시민',
};

const FALLBACK_CHAT = [
  '누가 수상하지?',
  '어젯밤 누가 그랬을까',
  '나는 시민이야',
  '다들 의견 좀 말해 봐',
  '흠…',
];
const FALLBACK_DEFEND = [
  '나 아니야',
  '나 시민이야 진짜',
  '왜 나를 의심해?',
  '난 아무것도 안 했어',
];

const RULES = [
  "너는 한국 친구들과 하는 파티 게임 '마피아'의 참가자다.",
  '역할은 마피아·경찰·의사·시민. 밤에 마피아가 한 명을 죽이고, 경찰은 한 명이 마피아인지 조사하고, 의사는 한 명을 살린다.',
  '낮에는 토론하고 투표로 한 명을 처형한다. 마피아를 모두 처형하면 시민 승, 마피아 수가 나머지 이상이면 마피아 승.',
  '죽은 사람의 역할은 끝날 때까지 공개되지 않는다.',
].join('\n');

/** 역할별로 낮에 말할 때의 방향 */
function roleGuide(
  role: MafiaRole,
  team: string[],
  findings: string[],
): string {
  switch (role) {
    case 'mafia':
      return `너는 마피아다(동료: ${team.join(', ') || '없음'}). 절대 들키지 말 것. 시민인 척하고, 동료를 의심하지 말고, 다른 사람에게 의심을 돌려라. 경찰이라고 거짓말해도 된다.`;
    case 'police':
      return `너는 경찰이다. 조사 결과: ${findings.join(', ') || '아직 없음'}. 마피아를 찾았으면 밝혀서 몰아가고, 아직 없으면 경찰인 걸 숨겨도 좋다(밝히면 밤에 죽을 수 있다).`;
    case 'doctor':
      return '너는 의사다. 의사인 걸 굳이 밝히지 말고, 수상한 사람을 찾아라.';
    default:
      return '너는 시민이다. 말과 행동이 이상한 사람을 찾아라.';
  }
}

/**
 * 마피아 봇.
 * 밤 행동은 규칙으로(빠르고 확실하게), 낮의 말·투표는 LLM으로(역할별 방향). 봇은 자기 역할로 알 수 있는 것만 쓴다
 * — 마피아면 동료, 경찰이면 자기 조사 결과. 남의 역할은 서버 상태에서 읽지 않는다.
 * LLM이 없거나 늦으면 미리 써 둔 문장·규칙 투표로 대신한다
 */
export function createMafiaBot(
  ctx: GameContext,
  mafia: MafiaHandler,
  self: BotSelf,
  llm: LlmCall,
): BotBrain {
  const { later, room } = botScheduler(ctx, self);
  const sock = self.sock;
  const roomName = self.roomName;
  const chatLog: { name: string; text: string }[] = [];
  let defendedDay = -1;
  /** 마피아 봇이 기억하는 '나(우리)를 의심한 사람' */
  const accusers = new Set<string>();

  /** 내가 아는 것만 */
  const view = () => {
    const r = room();
    const m = r?.mafia;
    if (!r || !m) return null;
    const role = m.roles.get(self.id);
    if (!role) return null;
    const team =
      role === 'mafia'
        ? [...m.roles].filter(([, x]) => x === 'mafia').map(([id]) => id)
        : [];
    const name = (id: string) => m.nicknames.get(id) ?? id;
    const findings =
      role === 'police'
        ? m.policeLog.map(
            (l) =>
              `${name(l.targetId)}=${l.isMafia ? '마피아' : '마피아 아님'}`,
          )
        : [];
    const aliveIn = [...m.alive].filter((id) =>
      [...r.playerIds.values()].includes(id),
    );
    return {
      r,
      m,
      role,
      team,
      name,
      findings,
      alive: aliveIn,
      me: m.alive.has(self.id),
    };
  };

  // ── 밤 ──
  const nightAct = () => {
    const v = view();
    if (!v || !v.me || v.m.phase !== 'night') return;
    const { m, role, team, alive } = v;
    const others = alive.filter((id) => id !== self.id);
    let target: string | undefined;
    if (role === 'mafia') {
      // 동료가 이미 골랐으면 따라간다. 아니면 우리를 의심한 사람, 없으면 아무나
      const mateChoice = [...m.kills].find(([k]) => k !== self.id)?.[1];
      const candidates = others.filter((id) => !team.includes(id));
      target =
        mateChoice ??
        pick(candidates.filter((id) => accusers.has(id))) ??
        pick(candidates);
      if (target) {
        // 동료를 따라가면 맞장구만 (둘이 똑같은 말을 하지 않게)
        const text = mateChoice
          ? pick(['좋아', 'ㅇㅋ 그렇게 하자', '찬성'])
          : `${v.name(target)} 어때`;
        mafia.handleText(
          { roomName, text: text ?? '좋아', whisper: true },
          sock,
        );
      }
    } else if (role === 'police') {
      const done = new Set(m.policeLog.map((l) => l.targetId));
      target = pick(others.filter((id) => !done.has(id))) ?? pick(others);
    } else if (role === 'doctor') {
      target = Math.random() < 0.35 ? self.id : pick(others);
    }
    if (target) mafia.handleAction({ roomName, targetId: target }, sock);
  };

  // ── 낮 ──
  const say = async (kind: 'chat' | 'defend') => {
    const v = view();
    if (!v || !v.me || v.m.phase !== 'day') return;
    const { m, role, team, name, findings, alive } = v;
    const myName = name(self.id);
    const answer = await llm({
      system: `${RULES}\n너의 이름은 "${myName}"이다. 너 자신을 3인칭으로 부르거나 의심하지 말 것.\n${roleGuide(role, team.map(name), findings)}\n지금은 낮 토론이다. 친구들끼리 채팅하듯 짧게 반말로 한 마디 해라.${
        kind === 'defend'
          ? ' 방금 누가 너를 의심했다. 자연스럽게 해명해라.'
          : ''
      }\n출력: 채팅 한 줄만. 30자 이내. 따옴표·이모지 없이.`,
      user: `${m.day}일째 낮\n어젯밤: ${
        m.lastNight?.killedId
          ? `${name(m.lastNight.killedId)} 죽음`
          : '아무도 안 죽음'
      }\n살아 있는 사람: ${alive.map(name).join(', ')}\n최근 채팅:\n${
        chatLog
          .slice(-10)
          .map((c) => `- ${c.name}: ${c.text}`)
          .join('\n') || '(없음)'
      }\n\n내 채팅:`,
    });
    const line = (answer?.split('\n').find((l) => l.trim()) ?? '')
      .replace(/^["'“”\s-]+|["'“”\s]+$/g, '')
      .slice(0, 60);
    // 마피아 봇이 실수로 자기가 마피아라고 말하지 않게
    const leaks = role === 'mafia' && /나\s*(는|가)?\s*마피아/.test(line);
    // 경찰이 살아 있는 마피아를 찾았으면 LLM 없이도 밝힌다 (안 그러면 시민 봇이 아무도 모른다)
    const found =
      role === 'police'
        ? m.policeLog.find((l) => l.isMafia && alive.includes(l.targetId))
        : undefined;
    const fallback = found
      ? `나 경찰인데 ${name(found.targetId)} 마피아야`
      : (pick(kind === 'defend' ? FALLBACK_DEFEND : FALLBACK_CHAT) ?? '흠…');
    const text = line && !leaks ? line : fallback;
    if (room()?.mafia?.phase === 'day')
      mafia.handleText({ roomName, text }, sock);
  };

  const vote = async () => {
    const v = view();
    if (!v || !v.me || v.m.phase !== 'day' || v.m.votes.has(self.id)) return;
    const { m, role, team, name, findings, alive } = v;
    const candidates = alive.filter(
      (id) => id !== self.id && !(role === 'mafia' && team.includes(id)),
    );
    if (candidates.length === 0) return;
    let target: string | undefined;
    if (role === 'police') {
      const found = m.policeLog.find(
        (l) => l.isMafia && alive.includes(l.targetId),
      );
      target = found?.targetId;
    }
    if (!target) {
      const names = candidates.map(name);
      const answer = await llm({
        system: `${RULES}\n너의 이름은 "${name(self.id)}"이다.\n${roleGuide(role, team.map(name), findings)}\n이제 처형 투표를 한다. 채팅을 보고 ${
          role === 'mafia'
            ? '마피아가 아닌 사람 중 처형되면 좋을 사람(의심을 많이 받는 시민이나 경찰 같아 보이는 사람)'
            : '가장 마피아 같은 사람'
        }을 골라라.\n출력: 후보 이름 하나만 그대로.`,
        user: `살아 있는 후보: ${names.join(', ')}\n최근 채팅:\n${
          chatLog
            .slice(-12)
            .map((c) => `- ${c.name}: ${c.text}`)
            .join('\n') || '(없음)'
        }\n\n투표할 이름:`,
      });
      const i = answer ? names.findIndex((n) => answer.includes(n)) : -1;
      target =
        i !== -1
          ? candidates[i]
          : fallbackVote(candidates, name, role === 'mafia');
    }
    const now = room()?.mafia;
    if (now && now.phase === 'day' && target)
      mafia.handleAction({ roomName, targetId: target }, sock);
  };

  /**
   * LLM 없을 때의 투표. 시민 쪽은 채팅에서 "○○ 마피아"라고 가장 많이 지목된 사람(경찰 주장 등),
   * 마피아는 우리 편을 의심한 사람, 둘 다 없으면 아무나.
   * (처음엔 모두 아무나 찍어서 마피아가 6~8명 판의 85%를 이겼다)
   */
  const fallbackVote = (
    candidates: string[],
    name: (id: string) => string,
    isMafia: boolean,
  ) => {
    if (isMafia)
      return (
        pick(candidates.filter((id) => accusers.has(id))) ?? pick(candidates)
      );
    const score = new Map<string, number>();
    for (const c of chatLog)
      if (c.text.includes('마피아'))
        for (const id of candidates)
          if (c.text.includes(name(id)) && c.name !== name(id))
            score.set(id, (score.get(id) ?? 0) + 1);
    const best = [...score].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : pick(candidates);
  };

  const run = (fn: () => Promise<void>) => () => {
    void fn().catch((e) => console.error(`[MafiaBot] ${self.id}`, e));
  };

  return (event: string, data: unknown) => {
    const d = (data ?? {}) as Record<string, unknown>;
    const m = room()?.mafia;
    switch (event) {
      case 'mafiaNight':
        chatLog.length = 0;
        later('night', nightAct, 3000 + Math.random() * 6000);
        break;
      case 'mafiaKillUpdate':
        // 동료가 먼저 고르면 아직 안 고른 마피아 봇은 곧 따라간다
        if (m && m.roles.get(self.id) === 'mafia' && !m.kills.has(self.id))
          later('night', nightAct, 1000 + Math.random() * 1500, true);
        break;
      case 'mafiaDay': {
        if (!m?.alive.has(self.id)) break;
        // 마피아를 찾은 경찰은 꼭 말한다 (일찍)
        const policeFound =
          m.roles.get(self.id) === 'police' &&
          m.policeLog.some((l) => l.isMafia && m.alive.has(l.targetId));
        if (policeFound)
          later(
            'chat',
            run(() => say('chat')),
            3000 + Math.random() * 4000,
          );
        else if (Math.random() < 0.7)
          later(
            'chat',
            run(() => say('chat')),
            4000 + Math.random() * 12000,
          );
        const ms = Number(d.timeLimitMs ?? 90000);
        later('vote', run(vote), ms * (0.35 + Math.random() * 0.3));
        break;
      }
      case 'mafiaChat': {
        const text = typeof d.text === 'string' ? d.text : '';
        const nick = typeof d.nickname === 'string' ? d.nickname : '';
        const pid = typeof d.playerId === 'string' ? d.playerId : '';
        if (!text || pid === self.id || d.scope !== 'all') break;
        chatLog.push({ name: nick, text });
        if (!m || !m.alive.has(self.id)) break;
        const myName = m.nicknames.get(self.id) ?? '';
        const role = m.roles.get(self.id);
        // 마피아 봇은 우리 편 이름을 꺼낸 사람을 기억한다 (밤에 노린다)
        if (role === 'mafia') {
          const team = [...m.roles]
            .filter(([, x]) => x === 'mafia')
            .map(([id]) => m.nicknames.get(id) ?? '');
          if (team.some((n) => n && text.includes(n))) accusers.add(pid);
        }
        if (
          m.phase === 'day' &&
          myName &&
          text.includes(myName) &&
          defendedDay !== m.day
        ) {
          defendedDay = m.day;
          later(
            'defend',
            run(() => say('defend')),
            2000 + Math.random() * 3000,
          );
        }
        break;
      }
      case 'mafiaVoteUpdate': {
        // 산 사람(사람)이 모두 투표했으면 봇도 곧
        const r = room();
        if (
          !r ||
          !m ||
          m.phase !== 'day' ||
          !m.alive.has(self.id) ||
          m.votes.has(self.id)
        )
          break;
        const humans = [...m.alive].filter(
          (id) =>
            !id.startsWith('bot:') && [...r.playerIds.values()].includes(id),
        );
        if (humans.length > 0 && humans.every((id) => m.votes.has(id)))
          later('vote', run(vote), 1500 + Math.random() * 2500, true);
        break;
      }
    }
  };
}

export { ROLE_NAME };
