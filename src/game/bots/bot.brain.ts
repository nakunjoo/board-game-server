import { WebSocket } from 'ws';
import { Room } from '../game.types';
import { GameContext } from '../game.context';
import { thinkMs } from './bot.util';

/** 봇 한 명 */
export interface BotSelf {
  id: string;
  sock: WebSocket;
  roomName: string;
}

/** 서버가 봇 소켓으로 보낸 이벤트를 받는 함수 */
export type BotBrain = (event: string, data: unknown) => void;

/**
 * 봇 두뇌가 쓰는 예약 도우미.
 * - 같은 이름의 할 일은 하나만 걸린다(이벤트가 몰려 와도 한 번만 행동)
 * - 실행할 때 봇이 아직 그 방에 있는지 다시 확인한다(그사이 빠졌거나 방이 없어졌으면 아무것도 안 함)
 */
export function botScheduler(ctx: GameContext, self: BotSelf) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const room = (): Room | undefined => {
    const r = ctx.rooms.get(self.roomName);
    return r && r.playerIds.get(self.sock) === self.id ? r : undefined;
  };
  const later = (
    name: string,
    fn: () => void,
    ms: number = thinkMs(),
    replace = false,
  ) => {
    if (timers.has(name)) {
      if (!replace) return;
      clearTimeout(timers.get(name));
    }
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        if (!room()) return;
        try {
          fn();
        } catch (e) {
          console.error(`[Bot] ${self.id} ${name} 실패`, e);
        }
      }, ms),
    );
  };
  return { later, room };
}
