# GCP Compute Engine 배포 가이드

## 사전 준비

### 1. GCP 계정 및 프로젝트 생성
1. [Google Cloud Console](https://console.cloud.google.com/) 접속
2. 새 프로젝트 생성 (예: `the-gang-game`)
3. 프로젝트 ID 기억해두기

### 2. 결제 계정 설정
1. GCP Console > Billing 메뉴
2. 결제 계정 연결 (신용카드 등록)
3. **프리티어**: 첫 90일 $300 크레딧 + e2-micro 인스턴스 무료

### 3. Google Cloud SDK 설치

**Windows:**
```bash
# PowerShell에서 실행
(New-Object Net.WebClient).DownloadFile("https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe", "$env:Temp\GoogleCloudSDKInstaller.exe")
& $env:Temp\GoogleCloudSDKInstaller.exe
```

**Mac/Linux:**
```bash
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
```

### 4. gcloud 초기화
```bash
gcloud init
# 브라우저에서 Google 계정 로그인
# 프로젝트 선택
```

## 배포 방법

### Option 1: 자동 배포 스크립트 (권장)

1. **배포 스크립트 수정**
   ```bash
   cd the-gang-server
   # deploy-gcp.sh 파일 열기
   # PROJECT_ID="your-gcp-project-id" 를 실제 프로젝트 ID로 변경
   ```

2. **실행 권한 부여**
   ```bash
   chmod +x deploy-gcp.sh
   ```

3. **배포 실행**
   ```bash
   ./deploy-gcp.sh
   ```

### Option 2: 수동 배포

#### Step 1: VM 인스턴스 생성
```bash
gcloud compute instances create the-gang-server \
  --zone=asia-northeast3-a \
  --machine-type=e2-micro \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=10GB \
  --tags=http-server,https-server
```

#### Step 2: 방화벽 규칙 생성
```bash
gcloud compute firewall-rules create the-gang-websocket \
  --allow tcp:9030 \
  --source-ranges 0.0.0.0/0 \
  --description "Allow WebSocket on port 9030"
```

#### Step 3: VM에 SSH 접속
```bash
gcloud compute ssh the-gang-server --zone=asia-northeast3-a
```

#### Step 4: VM 내부에서 Docker 설치
```bash
# Docker 설치
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# 재접속 (Docker 그룹 적용)
exit
gcloud compute ssh the-gang-server --zone=asia-northeast3-a
```

#### Step 5: 코드 배포
```bash
# 로컬에서 Docker 이미지 빌드
docker build -t the-gang-server:latest .

# 이미지를 tar로 저장
docker save the-gang-server:latest | gzip > the-gang-server.tar.gz

# VM에 전송
gcloud compute scp the-gang-server.tar.gz the-gang-server:/tmp/ --zone=asia-northeast3-a

# VM에서 실행
gcloud compute ssh the-gang-server --zone=asia-northeast3-a --command="
  docker load < /tmp/the-gang-server.tar.gz
  docker run -d --name the-gang-server --restart=always -p 9030:9030 the-gang-server:latest
"
```

## 클라이언트 설정

### 1. 서버 외부 IP 확인
```bash
gcloud compute instances describe the-gang-server \
  --zone=asia-northeast3-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

### 2. 클라이언트 WebSocket URL 변경
**파일**: `the-gang/src/contexts/WebSocketContext.tsx`

```typescript
// 기존
const ws = new WebSocket("ws://localhost:9030/ws");

// 변경 (예시 IP: 34.64.123.45)
const ws = new WebSocket("ws://34.64.123.45:9030/ws");
```

## 관리 명령어

### 로그 확인
```bash
gcloud compute ssh the-gang-server --zone=asia-northeast3-a \
  --command="sudo docker logs -f the-gang-server"
```

### 컨테이너 재시작
```bash
gcloud compute ssh the-gang-server --zone=asia-northeast3-a \
  --command="sudo docker restart the-gang-server"
```

### 컨테이너 중지
```bash
gcloud compute ssh the-gang-server --zone=asia-northeast3-a \
  --command="sudo docker stop the-gang-server"
```

### VM 인스턴스 중지 (비용 절감)
```bash
gcloud compute instances stop the-gang-server --zone=asia-northeast3-a
```

### VM 인스턴스 시작
```bash
gcloud compute instances start the-gang-server --zone=asia-northeast3-a
```

### VM 삭제 (완전 제거)
```bash
gcloud compute instances delete the-gang-server --zone=asia-northeast3-a
```

## 업데이트 방법

코드 변경 후 재배포:

```bash
# 1. Docker 이미지 다시 빌드
docker build -t the-gang-server:latest .

# 2. 이미지 저장 및 전송
docker save the-gang-server:latest | gzip > the-gang-server.tar.gz
gcloud compute scp the-gang-server.tar.gz the-gang-server:/tmp/ --zone=asia-northeast3-a

# 3. VM에서 컨테이너 교체
gcloud compute ssh the-gang-server --zone=asia-northeast3-a --command="
  docker stop the-gang-server
  docker rm the-gang-server
  docker load < /tmp/the-gang-server.tar.gz
  docker run -d --name the-gang-server --restart=always -p 9030:9030 the-gang-server:latest
  rm /tmp/the-gang-server.tar.gz
"

# 4. 로컬 임시 파일 삭제
rm the-gang-server.tar.gz
```

## 비용 최적화 팁

### 1. 프리티어 활용
- **e2-micro**: 매월 1개 무료 (us-west1, us-central1, us-east1 리전)
- **아시아 리전**: 프리티어 적용 안됨 → 서울(asia-northeast3) 사용 시 소액 과금

### 2. 사용하지 않을 때 인스턴스 중지
```bash
# 중지 (스토리지 비용만 발생: ~$0.04/월)
gcloud compute instances stop the-gang-server --zone=asia-northeast3-a

# 시작
gcloud compute instances start the-gang-server --zone=asia-northeast3-a
```

### 3. 고정 IP 사용 안 함
- 임시(Ephemeral) IP 무료
- 고정(Static) IP는 $3.65/월

## 모니터링

### GCP Console에서 확인
1. [Compute Engine > VM 인스턴스](https://console.cloud.google.com/compute/instances)
2. CPU/메모리 사용량 그래프 확인
3. 로그 → Cloud Logging 연동 가능

### 비용 확인
1. [Billing > Cost table](https://console.cloud.google.com/billing/)
2. 일일 비용 추적

## 트러블슈팅

### WebSocket 연결 실패
1. 방화벽 규칙 확인
   ```bash
   gcloud compute firewall-rules list
   ```
2. 컨테이너 실행 확인
   ```bash
   gcloud compute ssh the-gang-server --zone=asia-northeast3-a \
     --command="sudo docker ps"
   ```

### 메모리 부족
- e2-micro는 1GB RAM → 동시 접속자 많으면 e2-small로 업그레이드
  ```bash
  gcloud compute instances stop the-gang-server --zone=asia-northeast3-a
  gcloud compute instances set-machine-type the-gang-server \
    --machine-type=e2-small \
    --zone=asia-northeast3-a
  gcloud compute instances start the-gang-server --zone=asia-northeast3-a
  ```

## 예상 비용 (서울 리전)

- **e2-micro**: $7.11/월
- **e2-small**: $16.79/월
- **네트워크**: 1GB 무료, 이후 $0.12/GB

**프리티어 활용 시 (미국 리전)**: 거의 무료!

## 다음 단계

1. ✅ **도메인 연결**: Cloudflare/Route53으로 도메인 설정
2. ✅ **HTTPS/WSS**: Let's Encrypt 인증서 설치
3. ✅ **Redis 추가**: 상태 영속화 (선택사항)
4. ✅ **CI/CD**: GitHub Actions 자동 배포
