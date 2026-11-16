import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { GameGateway } from '../../game.gateway';
import { LiarHandler } from './liar.handler';
import {
  errors,
  fakeDb,
  fakeSocket,
  received,
  receivedEvent,
} from '../../../../test/game-test-utils';

jest.mock('../../../database/supabase-admin', () => ({
  getSupabaseAdmin: jest.fn(),
}));

/**
 * 게이트웨이를 거친 라이어 한 게임 전체 흐름 (방 생성 → 8명 입장 → 9번째 거절 → 시작 →
 * 설명·채팅 → 투표 → 라이어 맞히기 → 결과 → 다음 판 → 종료). 핸들러 단위 테스트는 liar.handler.spec.ts
 */
describe('라이어 게임 흐름 (게이트웨이 경유)', () => {
  let ctx: GameContext;
  let liar: LiarHandler;
  let gateway: GameGateway;
  const R = '라이어방';
  const IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  let socks: Map<string, WebSocket>;

  const connectAs = (playerId: string) => {
    const sock = fakeSocket();
    ctx.clientAuth.set(sock, playerId);
    ctx.clientRooms.set(sock, new Set());
    return sock;
  };
  const sockOf = (id: string) => socks.get(id)!;
  const state = () => ctx.rooms.get(R)!.liar!;
  const speaker = () =>
    state().speakOrder[state().speakIndex % state().speakOrder.length];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ctx = new GameContext();
    liar = new LiarHandler(ctx, fakeDb());
    gateway = new GameGateway(
      { get: () => ({ createDeck: () => [] }) } as any, // 카드 게임 방도 만들 수 있게
      ctx,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      liar,
      fakeDb(),
      {} as any,
    );
    socks = new Map();
    const host = connectAs('p1');
    socks.set('p1', host);
    gateway.handleCreateRoom(
      { name: R, nickname: '닉네임여섯', gameType: 'liar' },
      host,
    );
    for (const id of IDS.slice(1)) {
      const s = connectAs(id);
      socks.set(id, s);
      gateway.handleJoinRoom({ name: R, nickname: `닉${id}` }, s);
    }
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('8명까지 들어오고 9번째는 거절된다 (다른 게임은 6명)', () => {
    expect(ctx.rooms.get(R)!.clients.size).toBe(8);
    const ninth = connectAs('p9');
    gateway.handleJoinRoom({ name: R, nickname: '닉p9' }, ninth);
    expect(errors(ninth)).toContain('방이 가득 찼습니다 (최대 8명)');
    expect(ctx.rooms.get(R)!.clients.size).toBe(8);

    const gangHost = connectAs('g1');
    gateway.handleCreateRoom(
      { name: 'gang', nickname: 'g1', gameType: 'gang' },
      gangHost,
    );
    for (let i = 2; i <= 6; i++)
      gateway.handleJoinRoom(
        { name: 'gang', nickname: `g${i}` },
        connectAs(`g${i}`),
      );
    expect(ctx.rooms.get('gang')!.clients.size).toBe(6);
    const seventh = connectAs('g7');
    gateway.handleJoinRoom({ name: 'gang', nickname: 'g7' }, seventh);
    expect(errors(seventh)).toContain('방이 가득 찼습니다 (최대 6명)');
  });

  it('한 게임을 처음부터 끝까지 진행한다', async () => {
    await gateway.handleLiarStart(
      { roomName: R, rounds: 1, laps: 2, discussTimeSec: 60 },
      sockOf('p1'),
    );
    expect(receivedEvent(sockOf('p8'), 'liarStarted')).toHaveLength(1);

    // 제시어: 라이어만 다른 단어, 아무도 라이어라고 안내받지 않음
    const s = state();
    for (const id of IDS) {
      const r = receivedEvent(sockOf(id), 'liarRound')[0].data;
      expect(r.isLiar).toBe(false);
      expect(r.word).toBe(id === s.liarId ? s.liarWord : s.word);
    }

    jest.advanceTimersByTime(LiarHandler.WORD_TIME_MS);
    expect(state().phase).toBe('describe');

    // 설명 중 다른 사람 채팅: 모두에게 가고 차례는 그대로
    const first = speaker();
    const chatter = IDS.find((id) => id !== first)!;
    gateway.handleLiarText(
      { roomName: R, text: '누구부터야' },
      sockOf(chatter),
    );
    expect(receivedEvent(sockOf(first), 'liarChat').at(-1)!.data.text).toBe(
      '누구부터야',
    );
    expect(state().speakIndex).toBe(0);

    // 8명 × 2바퀴 = 16줄 설명 (한 명은 시간 초과)
    jest.advanceTimersByTime(LiarHandler.DESC_TIME_MS);
    while (state().phase === 'describe')
      gateway.handleLiarText(
        { roomName: R, text: `설명 ${state().descriptions.length + 1}` },
        sockOf(speaker()),
      );
    expect(state().descriptions).toHaveLength(16);
    expect(state().descriptions[0]).toMatchObject({ skipped: true });
    expect(
      state()
        .descriptions.map((d) => d.lap)
        .at(-1),
    ).toBe(2);
    expect(state().phase).toBe('discuss');

    // 투표: 시민 둘은 엉뚱한 사람, 나머지 시민은 라이어 → 라이어 지목
    const liarId = state().liarId;
    const citizens = IDS.filter((id) => id !== liarId);
    const wrong = citizens.slice(0, 2);
    for (const id of citizens) {
      const target = wrong.includes(id)
        ? citizens.find((c) => c !== id)!
        : liarId;
      gateway.handleLiarVote({ roomName: R, targetId: target }, sockOf(id));
    }
    gateway.handleLiarVote(
      { roomName: R, targetId: citizens[0] },
      sockOf(liarId),
    );
    expect(state().phase).toBe('liarGuess');
    expect(receivedEvent(sockOf('p1'), 'liarGuessTime')[0].data.liarId).toBe(
      liarId,
    );

    // 새로고침한 라이어: 이제 자기가 라이어인 걸 안다. 시민 단어는 아직 안 보인다
    const reconnected = connectAs(liarId);
    gateway.handleJoinRoom({ name: R, nickname: 'x' }, reconnected);
    const joined = receivedEvent(reconnected, 'roomJoined')[0].data;
    expect(joined.liar.isLiar).toBe(true);
    expect(joined.liar.word).toBe(state().liarWord);
    socks.set(liarId, reconnected);

    // 못 맞힘 → 시민 승, 라이어를 찍은 시민만 +1
    gateway.handleLiarText({ roomName: R, text: '전혀아닌답' }, sockOf(liarId));
    const result = receivedEvent(sockOf('p1'), 'liarRoundResult')[0].data;
    expect(result).toMatchObject({ winner: 'citizens', reason: 'guessFailed' });
    for (const id of citizens)
      expect(result.gains[id] ?? 0).toBe(wrong.includes(id) ? 0 : 1);
    expect(result.isLast).toBe(true);

    jest.advanceTimersByTime(LiarHandler.RESULT_TIME_MS);
    const over = receivedEvent(sockOf('p1'), 'liarGameOver')[0].data;
    expect(over.reason).toBe('finished');
    expect(over.ranking).toHaveLength(8);
    expect(ctx.rooms.get(R)!.gameStarted).toBe(false);

    // 다른 사람의 단어가 개인 메시지로 새지 않았는지
    for (const id of citizens) {
      const leaked = received(sockOf(id)).some(
        (m) =>
          m.event !== 'liarRoundResult' &&
          JSON.stringify(m.data).includes(`"${result.liarWord}"`),
      );
      expect(leaked).toBe(false);
    }
  });
});
