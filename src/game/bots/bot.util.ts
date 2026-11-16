import { WebSocket } from 'ws';

/**
 * 봇 플레이어 공통.
 *
 * 봇은 서버 안의 가짜 소켓이다. 방의 clients·playerIds·nicknames·playerOrder·hands에
 * 사람과 똑같이 들어가므로, 게임 핸들러는 봇을 따로 신경 쓰지 않는다.
 * 서버가 그 소켓으로 보내는 이벤트를 봇 두뇌(games/*.bot.ts)가 받아, 사람처럼 핸들러 메서드를 부른다.
 */
export const BOT_ID_PREFIX = 'bot:';

export function isBotId(playerId: string | null | undefined): boolean {
  return !!playerId && playerId.startsWith(BOT_ID_PREFIX);
}

export interface BotSocket {
  readyState: number;
  isBot: true;
  send(raw: string): void;
  /** 방이 없어지거나 봇을 뺄 때. 이후 오는 이벤트는 버린다 */
  close(): void;
}

export function isBotSocket(client: unknown): client is BotSocket {
  return !!client && (client as BotSocket).isBot === true;
}

/** 받은 이벤트를 다음 틱에 두뇌로 넘긴다 (사람 소켓처럼 비동기 — 핸들러 안에서 바로 되부르지 않게) */
export function createBotSocket(
  onEvent: (event: string, data: unknown) => void,
): WebSocket {
  const sock: BotSocket = {
    readyState: WebSocket.OPEN,
    isBot: true,
    send(raw: string) {
      if (sock.readyState !== WebSocket.OPEN) return;
      const { event, data } = JSON.parse(raw) as {
        event: string;
        data: unknown;
      };
      setTimeout(() => {
        if (sock.readyState !== WebSocket.OPEN) return;
        try {
          onEvent(event, data);
        } catch (e) {
          // 봇 하나의 실수로 게임이 멈추지 않게 (서버 타이머가 대신 진행한다)
          console.error('[Bot] 이벤트 처리 실패', event, e);
        }
      }, 0);
    },
    close() {
      sock.readyState = WebSocket.CLOSED;
    },
  };
  return sock as unknown as WebSocket;
}

/** 사람처럼 잠깐 생각하는 시간 (ms) */
export function thinkMs(min = 900, max = 2200): number {
  return min + Math.floor(Math.random() * (max - min));
}
