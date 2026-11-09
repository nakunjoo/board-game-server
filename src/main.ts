import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

// 방 상태가 전부 메모리에 있어서, 놓친 rejection 하나로 프로세스가 죽으면 진행 중인 모든 게임이 사라진다
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
    methods: ['GET', 'PATCH', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  await app.listen(process.env.PORT ?? 9030);
  console.log(`Application is running on: ${await app.getUrl()}`);
  console.log(
    `WebSocket endpoint: ws://localhost:${process.env.PORT ?? 9030}/ws`,
  );
}
bootstrap().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
