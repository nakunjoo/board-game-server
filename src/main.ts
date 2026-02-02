import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 9030);
  console.log(`Application is running on: ${await app.getUrl()}`);
  console.log(
    `WebSocket endpoint: ws://localhost:${process.env.PORT ?? 9030}/ws`,
  );
}
bootstrap();
