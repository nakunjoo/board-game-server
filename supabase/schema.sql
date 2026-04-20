-- ============================================================
-- BOBOGANG Supabase Schema
-- ============================================================

-- UUID 확장
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- profiles
-- ============================================================
CREATE TABLE profiles (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname        text NOT NULL,
  avatar_url      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  is_banned       bool NOT NULL DEFAULT false,
  ban_reason      text
);

-- 구글 로그인 시 자동으로 profiles 생성
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO profiles (id, nickname, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.email, 'Player'),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- game_sessions
-- ============================================================
CREATE TABLE game_sessions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_name       text NOT NULL,
  game_type       text NOT NULL CHECK (game_type IN ('gang', 'spice', 'skulking')),
  played_at       timestamptz NOT NULL DEFAULT now(),
  duration_sec    int,
  player_count    int NOT NULL,
  total_rounds    int
);

-- ============================================================
-- game_player_results
-- ============================================================
CREATE TABLE game_player_results (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- 로그인 붙이면 채워짐
  player_id       text NOT NULL,  -- 클라이언트 생성 ID (로그인 전 임시 식별자)
  nickname        text NOT NULL,
  is_winner       bool,
  score           int,
  rank            int,
  status          text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'abandoned')),
  abandoned_at    timestamptz,
  play_time_sec   int,
  extra           jsonb
);

CREATE INDEX idx_game_player_results_user_id ON game_player_results(user_id);
CREATE INDEX idx_game_player_results_session_id ON game_player_results(session_id);

-- ============================================================
-- friendships
-- ============================================================
CREATE TABLE friendships (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, friend_id)
);

CREATE INDEX idx_friendships_user_id ON friendships(user_id);
CREATE INDEX idx_friendships_friend_id ON friendships(friend_id);

-- ============================================================
-- reports
-- ============================================================
CREATE TABLE reports (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reported_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES game_sessions(id) ON DELETE SET NULL,
  reason          text NOT NULL CHECK (reason IN ('cheating', 'abusive', 'afk', 'other')),
  description     text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_reported_id ON reports(reported_id);
CREATE INDEX idx_reports_status ON reports(status);

-- ============================================================
-- RLS (Row Level Security)
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_player_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- profiles: 본인만 수정, 전체 조회 가능
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- game_sessions: 전체 조회 가능, 서버만 insert (service_role)
CREATE POLICY "sessions_select" ON game_sessions FOR SELECT USING (true);
CREATE POLICY "sessions_insert" ON game_sessions FOR INSERT WITH CHECK (true);

-- game_player_results: 전체 조회 가능, 서버만 insert/update
CREATE POLICY "results_select" ON game_player_results FOR SELECT USING (true);
CREATE POLICY "results_insert" ON game_player_results FOR INSERT WITH CHECK (true);
CREATE POLICY "results_update" ON game_player_results FOR UPDATE USING (true);

-- friendships: 본인 관련 데이터만 조회/수정
CREATE POLICY "friendships_select" ON friendships
  FOR SELECT USING (auth.uid() = user_id OR auth.uid() = friend_id);
CREATE POLICY "friendships_insert" ON friendships
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "friendships_update" ON friendships
  FOR UPDATE USING (auth.uid() = user_id OR auth.uid() = friend_id);
CREATE POLICY "friendships_delete" ON friendships
  FOR DELETE USING (auth.uid() = user_id OR auth.uid() = friend_id);

-- reports: 본인이 신고한 것만 조회, insert는 본인만
CREATE POLICY "reports_select" ON reports
  FOR SELECT USING (auth.uid() = reporter_id);
CREATE POLICY "reports_insert" ON reports
  FOR INSERT WITH CHECK (auth.uid() = reporter_id);
