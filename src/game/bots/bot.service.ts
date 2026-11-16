import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { GameContext } from '../game.context';
import { GangHandler } from '../games/gang/gang.handler';
import { SpiceHandler } from '../games/spice/spice.handler';
import { SkulkingHandler } from '../games/skulking/skulking.handler';
import { BOT_ID_PREFIX, createBotSocket, isBotId } from './bot.util';
import { BotBrain, BotSelf } from './bot.brain';
import { createGangBot } from './gang.bot';
import { createSkulkingBot } from './skulking.bot';
import { createSpiceBot } from './spice.bot';

/**
 * 방장이 대기 중인 방에 봇을 넣고 뺀다 (사람이 모자랄 때 채우기, 혼자 연습).
 *
 * 이벤트 (클라이언트 → 서버, 방장 전용·게임 시작 전):
 *   addBot    {roomName}
 *   removeBot {roomName, playerId?} — 없으면 마지막에 넣은 봇
 * 서버 → 클라이언트는 사람이 들어오고 나갈 때와 같은 userJoined / userLeft.
 * 봇 id는 'bot:'으로 시작하고 닉네임은 🤖봇1~8. 전적(DB)에는 남기지 않는다(database.service.ts).
 * 사람이 모두 나가면 봇도 빠지고 방이 닫힌다(game.context.ts leaveRoom).
 */
@Injectable()
export class BotService {
  static readonly SUPPORTED_GAMES = ['gang', 'spice', 'skulking'];
  private seq = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly gang: GangHandler,
    private readonly spice: SpiceHandler,
    private readonly skulking: SkulkingHandler,
  ) {}

  /** 요청한 사람이 이 방의 방장이고, 게임 시작 전이고, 봇을 지원하는 게임인지. 아니면 에러를 보내고 null */
  private checkHost(roomName: string, client: WebSocket) {
    const room = this.ctx.rooms.get(roomName);
    const fail = (message: string) => {
      this.ctx.sendToClient(client, 'error', { message });
      return null;
    };
    if (!room || !room.clients.has(client))
      return fail(`'${roomName}' 방에 참여하고 있지 않습니다`);
    if (room.playerIds.get(client) !== room.hostPlayerId)
      return fail('방장만 봇을 넣고 뺄 수 있습니다');
    // 향신료·스컬킹은 선뽑기 동안 아직 gameStarted가 아니다
    if (
      room.gameStarted ||
      room.state.firstDraw ||
      room.state.skulkingFirstDraw
    )
      return fail('게임 중에는 봇을 넣고 뺄 수 없습니다');
    if (!BotService.SUPPORTED_GAMES.includes(room.gameType))
      return fail('이 게임은 아직 봇을 지원하지 않습니다');
    return room;
  }

  addBot(
    data: { roomName: string },
    client: WebSocket,
    maxPlayers: number,
  ): void {
    const room = this.checkHost(data.roomName, client);
    if (!room) return;
    if (room.clients.size >= maxPlayers) {
      this.ctx.sendToClient(client, 'error', {
        message: `방이 가득 찼습니다 (최대 ${maxPlayers}명)`,
      });
      return;
    }

    const taken = new Set(room.nicknames.values());
    let n = 1;
    while (taken.has(`🤖봇${n}`)) n++;
    const nickname = `🤖봇${n}`;
    const id = `${BOT_ID_PREFIX}${Date.now().toString(36)}${(this.seq++).toString(36)}`;

    let brain: BotBrain = () => {};
    const sock = createBotSocket((event, payload) => brain(event, payload));
    const self: BotSelf = { id, sock, roomName: room.name };
    brain = this.createBrain(room.gameType, self);

    room.clients.add(sock);
    room.playerIds.set(sock, id);
    room.nicknames.set(sock, nickname);
    room.state.hands.set(sock, []);
    room.state.playerOrder.push(sock);

    const players = this.ctx.getPlayersWithOrder(room);
    this.ctx.broadcastToRoom(room.name, 'userJoined', {
      roomName: room.name,
      memberCount: room.clients.size,
      playerId: id,
      nickname,
      order: players.find((p) => p.playerId === id)?.order ?? 0,
      players,
    });
    console.log(
      `[Bot] ${nickname} (${id}) joined '${room.name}' (${room.gameType})`,
    );
  }

  removeBot(
    data: { roomName: string; playerId?: string },
    client: WebSocket,
  ): void {
    const room = this.checkHost(data.roomName, client);
    if (!room) return;
    const bots = Array.from(room.playerIds).filter(([, id]) => isBotId(id));
    const target = data.playerId
      ? bots.find(([, id]) => id === data.playerId)
      : bots.at(-1);
    if (!target) return;
    const [sock] = target;
    (sock as unknown as { close?: () => void }).close?.();
    this.ctx.leaveRoom(sock, room.name);
  }

  private createBrain(gameType: string, self: BotSelf): BotBrain {
    switch (gameType) {
      case 'gang':
        return createGangBot(this.ctx, this.gang, self);
      case 'skulking':
        return createSkulkingBot(this.ctx, this.skulking, self);
      case 'spice':
        return createSpiceBot(this.ctx, this.spice, self);
      default:
        return () => {};
    }
  }
}
